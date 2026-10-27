import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DetectedServer, knownServers } from "../../src/classifier/detect.ts";
import type { EvalReport } from "../../src/classifier/eval.ts";
import { serverCatalog } from "../../src/classifier/servers.ts";
import { commandLine, listedAs, mergeClassifierConfig, runSetup, type SetupDeps, timeoutFor } from "../../src/classifier/setup.ts";
import { which } from "../../src/cli/classifier.ts";

const catalog = serverCatalog();
const [decisionSetup, decisionSpec] = Object.entries(catalog.setups).find(([, spec]) => !spec.chat && spec.run && !spec.serve) ?? [];
const [servedSetup, servedSpec] = Object.entries(catalog.setups).find(([, spec]) => !spec.chat && spec.serve) ?? [];
const [chatSetup, chatSpec] = Object.entries(catalog.setups).find(([, spec]) => spec.chat) ?? [];
const serverOf = (name: string) => knownServers().find((server) => server.kind === (catalog.setups[name]?.server ?? name));

function rig(over: Partial<SetupDeps> & { models?: string[]; chatModels?: string[]; config?: string; answers?: boolean[] } = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const ran: string[][] = [];
	const asked: string[] = [];
	const written: string[] = [];
	const answers = [...(over.answers ?? [])];
	const deps: SetupDeps = {
		which: (command) => (command.startsWith("~") ? undefined : `/usr/bin/${command}`),
		run: async (command, args) => {
			ran.push([command, ...args]);
			return 0;
		},
		confirm: async (question) => {
			asked.push(question);
			return answers.shift() ?? true;
		},
		out: (text) => void out.push(text),
		err: (text) => void err.push(text),
		probe: async (server) =>
			({
				...server,
				baseUrl: `${server.origin}/v1`,
				decisionModels: over.models ?? [],
				chatModels: over.chatModels ?? [],
				cloudModels: [],
			}) as DetectedServer,
		smoke: async (_server, model) => ({ model, ok: true, ms: 42 }),
		load: async (_server, model) => {
			ran.push(["load", model]);
			return undefined;
		},
		evaluate: async () => ({ best: { threshold: 0.6, correct: 22, under: 0 }, medianMs: 190 }) as EvalReport,
		configPath: "/home/me/.pi/agent/pi-switchboard.json",
		readConfig: () => over.config,
		writeConfig: (text) => void written.push(text),
		sleep: async () => {},
		...over,
	};
	return { deps, out, err, ran, asked, written };
}

describe("classifier setup", () => {
	it("ships a setup for each kind of route", () => {
		assert.ok(decisionSetup && servedSetup && chatSetup, "a setup that runs commands, one whose server the user starts, and a chat-model one");
		for (const [name, spec] of Object.entries(catalog.setups)) assert.ok(serverOf(name), `${name} sets up a known server (${spec.server ?? name})`);
	});

	it("shows the commands, asks once, runs them, tests the model, chooses the threshold and writes the config after asking", async () => {
		const spec = decisionSpec!;
		const r = rig({ models: [`${spec.model}:latest`], config: '{ "profiles": {}, "classifiers": [{ "model": "old/judge" }] }' });
		assert.equal(await runSetup(decisionSetup, {}, r.deps), 0);
		assert.deepEqual(r.asked, ["Run them?", "Write it?"]);
		assert.equal(r.ran.length, spec.run?.length);
		assert.ok(
			r.ran.every((words) => words[0]?.startsWith("/usr/bin/")),
			"{bin} becomes the command found",
		);
		const config = JSON.parse(r.written[0] ?? "{}");
		const server = serverOf(decisionSetup!)!;
		assert.deepEqual(config.classifiers, [{ model: `${server.name}/${spec.model}:latest`, timeoutMs: 2000, threshold: 0.6 }, { model: "old/judge" }]);
		assert.equal(config.classifierProviders[0].name, server.name);
		assert.deepEqual(config.profiles, {});
		assert.match(r.out.join(""), /22\/24 route as labelled at threshold 0\.6/);
		assert.doesNotMatch(r.out.join(""), /budget/);
	});

	it("sizes the timeout from the measured latency and warns past the decision budget", async () => {
		assert.deepEqual([timeoutFor(190), timeoutFor(1300), timeoutFor(13_453)], [2000, 3000, 27_000]);
		const slow = rig({
			models: [decisionSpec!.model],
			evaluate: async () => ({ best: { threshold: 0.7, correct: 21, under: 0 }, medianMs: 13_453 }) as EvalReport,
		});
		assert.equal(await runSetup(decisionSetup, { yes: true }, slow.deps), 0);
		assert.equal(JSON.parse(slow.written[0] ?? "{}").classifiers[0].timeoutMs, 27_000);
		assert.match(slow.out.join(""), /more slowly than pi-switchboard's 4 s budget/);
	});

	it("waits for a server the user starts, and gives up after the wait", async () => {
		const spec = servedSpec!;
		const ready = rig({ models: [spec.model] });
		assert.equal(await runSetup(servedSetup, { yes: true, evaluate: false }, ready.deps), 0);
		assert.equal(ready.ran.length, 0);
		assert.match(ready.out.join(""), /Start the server in another terminal[\s\S]*\$ \/usr\/bin\//);
		assert.equal(JSON.parse(ready.written[0] ?? "{}").classifiers[0].threshold, 0.8);
		const never = rig({ models: [] });
		assert.equal(await runSetup(servedSetup, { yes: true, waitMs: 4000 }, never.deps), 1);
		assert.match(never.err.join(""), /did not list .* within 0 minutes/);
	});

	it("configures a chat model through pi's provider, with a softer temperature, and no provider entry", async () => {
		const spec = chatSpec!;
		const r = rig({ chatModels: [spec.model], config: '{ "classification": { "decisionBudgetMs": 5000 } }' });
		assert.equal(await runSetup(chatSetup, { yes: true }, r.deps), 0);
		const config = JSON.parse(r.written[0] ?? "{}");
		const server = serverOf(chatSetup!)!;
		assert.deepEqual(config.classifiers, [{ model: `${server.chatProvider}/${spec.model}`, timeoutMs: 3000, threshold: 0.8 }]);
		assert.deepEqual(config.classification, { decisionBudgetMs: 5000, temperature: 2 });
		assert.equal(config.classifierProviders, undefined);
		assert.match(r.out.join(""), /is a chat model; pi reads it through/);
		assert.match(r.out.join(""), /First download the model[\s\S]*Ctrl\+C[\s\S]*Then start the server/);
		assert.deepEqual(r.ran, [["load", spec.model]]);
		const refused = rig({ chatModels: [spec.model], load: async () => "404 File Not Found" });
		assert.equal(await runSetup(chatSetup, { yes: true }, refused.deps), 1);
		assert.match(refused.err.join(""), /could not load .*404 File Not Found/);
	});

	it("stops without the product, on a declined confirm, a failing command, a model that does not answer, or malformed config", async () => {
		const missing = rig({ which: () => undefined });
		assert.equal(await runSetup(decisionSetup, {}, missing.deps), 1);
		assert.match(missing.err.join(""), /was not found\. /);
		const declined = rig({ answers: [false] });
		assert.equal(await runSetup(decisionSetup, {}, declined.deps), 1);
		assert.equal(declined.ran.length, 0);
		const failing = rig({ run: async () => 3 });
		assert.equal(await runSetup(decisionSetup, { yes: true }, failing.deps), 1);
		assert.match(failing.err.join(""), /exited with 3/);
		const silent = rig({ models: [decisionSpec!.model], smoke: async (_s, model) => ({ model, ok: false, ms: 1, error: "Model is unloaded" }) });
		assert.equal(await runSetup(decisionSetup, { yes: true }, silent.deps), 1);
		assert.match(silent.err.join(""), /did not answer: Model is unloaded/);
		const malformed = rig({ models: [decisionSpec!.model], config: "{ nope" });
		assert.equal(await runSetup(decisionSetup, { yes: true, evaluate: false }, malformed.deps), 1);
		assert.match(malformed.err.join(""), /is not valid JSON, so it is left alone/);
		assert.equal(malformed.written.length, 0);
		const unknown = rig();
		assert.equal(await runSetup("nope", {}, unknown.deps), 1);
		assert.match(unknown.err.join(""), /name one of /);
	});

	it("merges providers by name and classifiers by model, and quotes commands for display", () => {
		const merged = mergeClassifierConfig(
			{ classifierProviders: [{ name: "a", baseUrl: "x" }, { name: "b" }], classifiers: [{ model: "b/m" }, { model: "a/m" }] },
			{ classifierProviders: [{ name: "a" }], classifiers: [{ model: "a/m" }] },
		);
		assert.deepEqual(merged, { classifierProviders: [{ name: "b" }, { name: "a" }], classifiers: [{ model: "a/m" }, { model: "b/m" }] });
		assert.equal(listedAs(["x:latest", "y"], "x"), "x:latest");
		assert.equal(commandLine(["run", "it's here", "-hf", "org/model:Q4"]), "run 'it'\\''s here' -hf org/model:Q4");
		assert.equal(which("sh", { PATH: "/nowhere:/bin" }), "/bin/sh");
		assert.equal(which("~/missing-tool", { HOME: "/tmp" }), undefined);
		assert.equal(which("no-such-command-here", { PATH: "/bin" }), undefined);
	});
});
