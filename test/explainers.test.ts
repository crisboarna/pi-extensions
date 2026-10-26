// The site's static explainers run the packages' own code; these tests hold
// them to the same answers as the commands they explain: /guard check and
// /tier try with typed answers.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { registerGuard } from "../packages/pi-account-guard/src/pi/hooks.ts";
import { attachDialogs } from "../packages/pi-account-guard/test/support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../packages/pi-account-guard/test/support/fake-pi.ts";
import type { RawConfig } from "../packages/pi-switchboard/src/config/types.ts";
import type { Answers } from "../packages/pi-switchboard/src/rules/types.ts";
import { engine, RAW } from "../packages/pi-switchboard/test/support/engine.ts";
import { ROOT } from "../scripts/lib/repo.ts";
import { explainGuard, type GuardQuestion } from "../tools/site/explainers/account-guard.ts";
import { resolve } from "../tools/site/explainers/node-path.ts";
import { routeAnswers } from "../tools/site/explainers/switchboard.ts";

const HOME = "/home/me";
const example = readFileSync(join(ROOT, "packages", "pi-account-guard", "examples", "account-guard.json"), "utf8");

/** The text `/guard check <directory> <provider> <source>` prints for the same file and remotes. */
async function guardCheck(question: GuardQuestion): Promise<string | undefined> {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: HOME, model: null, hasUI: true });
	const dialogs = attachDialogs(host, session, []);
	registerGuard(dialogs.pi as never, {
		home: HOME,
		configPath: `${HOME}/.pi/agent/account-guard.json`,
		readConfigText: () => (question.configText.trim() === "" ? undefined : question.configText),
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: question.remotes }),
		writeStderr: () => {},
		setExitCode: () => {},
	});
	await host.commands.get("guard")!.handler(`check ${question.directory} ${question.provider} ${question.source}`, session.ctx);
	return session.notices.at(-1)?.message;
}

describe("account-guard's config tester", () => {
	const cases: Array<Omit<GuardQuestion, "home">> = [
		{ configText: example, directory: "~/Projects/acme/billing", remotes: [], provider: "openai-codex-2", source: "oauth" },
		{ configText: example, directory: "~/src/api", remotes: ["git@github.com:acme-corp/api.git"], provider: "openai-codex-2", source: "oauth" },
		{ configText: example, directory: "~/garden", remotes: ["https://github.com/me/garden.git"], provider: "openai-codex-2", source: "oauth" },
		{ configText: example, directory: "~/garden", remotes: [], provider: "homelab", source: "env:HOMELAB_KEY" },
		{ configText: "", directory: "/srv/tools", remotes: [], provider: "homelab", source: "oauth" },
	];
	for (const question of cases)
		it(`answers like /guard check for ${question.directory} and ${question.provider}`, async () => {
			const answer = explainGuard({ ...question, home: HOME });
			assert.ok(answer.ok);
			assert.equal(answer.text, await guardCheck({ ...question, home: HOME }));
		});

	it("names the rule, the zone and the verdict, and reports a malformed file", () => {
		const remote = explainGuard({ ...cases[1]!, home: HOME });
		assert.deepEqual(remote.ok && [remote.zone, remote.rule, remote.verdict], ["work", 0, "match"]);
		const broken = explainGuard({ ...cases[0]!, configText: '{ "zones": ["work"], "defaultZone": "home" }', home: HOME });
		assert.ok(!broken.ok);
		assert.match(broken.errors.join("\n"), /account-guard\.json: defaultZone/);
	});

	it("resolves paths in the browser as node:path does", () => {
		assert.equal(resolve("/home/me", "~/x".replace("~", "/home/me")), "/home/me/x");
		assert.equal(resolve("/home/me/garden", "../work/./api/"), "/home/me/work/api");
		assert.equal(resolve("/a", "/b", "c"), "/b/c");
	});
});

const typed = (work: string, workConfidence: number, depth: number, risky: number): Answers => ({
	work: { type: "choice", choice: work, probabilities: { [work]: workConfidence }, confidence: workConfidence },
	depth: { type: "score", score: depth, confidence: 1 },
	risky: { type: "bool", probability: risky },
});

describe("pi-switchboard's rule playground", () => {
	const grid: Answers[] = [];
	for (const work of ["mechanical", "research", "implement", "plan", "review"])
		for (const depth of [0.2, 1, 1.8])
			for (const risky of [0.05, 0.9]) for (const confidence of [0.95, 0.5]) grid.push(typed(work, confidence, depth, risky));

	const configs: Array<[string, RawConfig]> = [
		["the test config", RAW],
		...readdirSync(join(ROOT, "packages", "pi-switchboard", "examples")).map((file): [string, RawConfig] => [
			`examples/${file}`,
			JSON.parse(readFileSync(join(ROOT, "packages", "pi-switchboard", "examples", file), "utf8")) as RawConfig,
		]),
	];
	for (const [label, raw] of configs)
		it(`gives the tier and rule /tier try gives, for ${grid.length} typed answers on ${label}`, async () => {
			const { e } = engine({ raw });
			for (const answers of grid) {
				const preview = await e.preview("x", { answers });
				const played = routeAnswers({ configText: JSON.stringify(raw), answers });
				assert.ok(played.ok && preview);
				assert.equal(played.decision.tier, preview.tier.chosen, JSON.stringify(answers));
				assert.equal(played.outcome.ruleIndex, preview.rules?.matched, JSON.stringify(answers));
			}
		});

	it("reports a config that is not JSON or has no valid profile", () => {
		const broken = routeAnswers({ configText: "{", answers: typed("plan", 1, 1, 0) });
		assert.ok(!broken.ok);
		assert.match(broken.errors[0]!, /not JSON/);
		const empty = routeAnswers({ configText: "{}", answers: typed("plan", 1, 1, 0) });
		assert.ok(!empty.ok);
	});
});
