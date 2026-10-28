// End to end in real pi with both packages installed together, as users have
// them: pi-switchboard and pi-account-guard packed into tarballs and installed
// into one agent folder, with pi-switchboard's stand-in models and classifier
// (packages/pi-switchboard/test/e2e/support). account-guard treats the virtual
// model `switchboard/auto` as one account, `switchboard (env:virtual)`, and
// does not check the member behind it (its ADR 0004 and
// docs/with-other-extensions.md). Runs in `npm run test:e2e`, and so in CI;
// `npm test` leaves it out (`test:repo` runs only test/*.test.ts).
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Installed, installTarball, writeSettings } from "../../packages/pi-switchboard/test/e2e/support/install.ts";
import { PiSession } from "../../packages/pi-switchboard/test/e2e/support/pi-rpc.ts";
import { run } from "../../packages/pi-switchboard/test/e2e/support/proc.ts";
import { isolatedEnv, REPO, type Run, startRun } from "../../packages/pi-switchboard/test/e2e/support/run.ts";
import { StandinClassifier } from "../../packages/pi-switchboard/test/e2e/support/standin-classifier.ts";
import { readRequests, type Script, STANDIN_EXTENSION, writeScript } from "../../packages/pi-switchboard/test/e2e/support/standin-provider.ts";
import { routingConfig } from "../../packages/pi-switchboard/test/e2e/support/standins.ts";

const SWITCHBOARD = "@crisboarna/pi-switchboard";
const GUARD = "@crisboarna/pi-account-guard";
const PI_CLI = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const SETTINGS = { extensions: [STANDIN_EXTENSION], retry: { enabled: true, baseDelayMs: 50 } };
/** The virtual model's account, tagged personal; the stand-in alpha account, tagged work. */
const VIRTUAL = { provider: "switchboard", source: "env:virtual" };
const ALPHA = { provider: "alpha", source: "fallback" };

describe("pi-switchboard and pi-account-guard in one pi", { timeout: 300_000 }, () => {
	let runDir: Run;
	let installed: Installed;
	let classifier: StandinClassifier;
	/** A place rule makes this folder work; any other is personal, the default zone. */
	let work: string;
	let personal: string;
	const sessions: PiSession[] = [];
	const explain = (text: string) => runDir.explain(text);

	/** pi in `cwd`, on `switchboard/auto`, with the stand-in models scripted by `script`. */
	async function open(label: string, cwd: string, script: Script = {}): Promise<{ pi: PiSession; requests: () => ReturnType<typeof readRequests> }> {
		classifier.reset();
		const config = join(runDir.dir, `${label}.json`);
		const scriptPath = join(runDir.dir, `${label}.script.json`);
		const log = join(runDir.dir, `${label}.requests.jsonl`);
		writeFileSync(config, JSON.stringify(routingConfig(classifier)));
		writeScript(scriptPath, script);
		const pi = await PiSession.start({
			env: env({ PI_SWITCHBOARD_CONFIG: config, STANDIN_SCRIPT: scriptPath, STANDIN_LOG: log }),
			cwd,
			log: join(runDir.dir, `pi-${label}`),
		});
		sessions.push(pi);
		await pi.setModel("switchboard", "auto");
		return { pi, requests: () => readRequests(log) };
	}
	const env = (extra: Record<string, string>) => isolatedEnv(installed.home, { PI_CODING_AGENT_DIR: installed.agentDir, ...extra });
	/** The title of the guard's Block select since `from`, if it showed one. */
	const blockTitle = (pi: PiSession, from: number) =>
		pi.recordsSince(from).find((record) => record.type === "extension_ui_request" && record.method === "select" && /^BLOCKED/u.test(String(record.title)))
			?.title as string | undefined;

	before(async () => {
		runDir = startRun("both");
		installed = await installTarball(runDir, { workspaces: [SWITCHBOARD, GUARD], settings: SETTINGS });
		work = realpathSync(runDir.folder("work"));
		personal = realpathSync(runDir.folder("personal"));
		writeFileSync(
			join(installed.agentDir, "account-guard.json"),
			JSON.stringify({
				accounts: [
					{ ...VIRTUAL, zones: ["personal"] },
					{ ...ALPHA, zones: ["work"] },
				],
				places: [{ path: work, zone: "work" }],
			}),
		);
		classifier = await StandinClassifier.start();
	});

	after(async () => {
		for (const pi of sessions) await pi.close();
		await classifier?.close();
		writeSettings(installed.agentDir, [SWITCHBOARD, GUARD], SETTINGS);
	});

	it("loads both, in either order, with no load error, and lists both commands", async () => {
		for (const order of [
			[SWITCHBOARD, GUARD],
			[GUARD, SWITCHBOARD],
		]) {
			writeSettings(installed.agentDir, order, SETTINGS);
			const pi = await PiSession.start({ env: env({}), cwd: personal, log: join(runDir.dir, `pi-load-${order[0]?.split("/")[1]}`) });
			sessions.push(pi);
			assert.ok(pi.commands.includes("tier") && pi.commands.includes("guard"), explain(`${order}: ${pi.commands.join(", ")}`));
			assert.deepEqual(pi.errors, [], explain(order.join(" then ")));
			assert.doesNotMatch(pi.stderr, /error|failed to load/iu, explain(pi.stderr));
		}
		writeSettings(installed.agentDir, [SWITCHBOARD, GUARD], SETTINGS);
	});

	it("blocks switchboard/auto in a work place before the classifier or any model sees the prompt, and routes it in a personal one", async () => {
		const blocked = await open("work-place", work);
		const from = blocked.pi.mark();
		await blocked.pi.submit("fix the build");
		assert.match(blockTitle(blocked.pi, from) ?? "", /^BLOCKED +switchboard \(env:virtual\) is zone personal/u, explain("no Block select"));
		assert.deepEqual(blocked.requests(), [], explain("a stand-in model was asked"));
		assert.deepEqual(classifier.requests, [], explain("the classifier was asked"));

		const allowed = await open("personal-place", personal);
		const turn = await allowed.pi.prompt("fix the build");
		assert.deepEqual(
			turn.replies.map((reply) => `${reply.provider}/${reply.model}`),
			["alpha/mid"],
			explain(JSON.stringify(turn.replies)),
		);
		assert.equal(classifier.requests.length, 1);
	});

	it("exits with 77 and the reason on stderr for a blocked `pi -p`, and sends nothing", async () => {
		const log = join(runDir.dir, "headless.requests.jsonl");
		const config = join(runDir.dir, "headless.json");
		writeFileSync(config, JSON.stringify(routingConfig(classifier)));
		classifier.reset();
		const result = await run(
			process.execPath,
			[PI_CLI, "--offline", "--no-session", "--provider", "switchboard", "--model", "auto", "-p", "fix the build"],
			{
				env: env({ PI_SWITCHBOARD_CONFIG: config, STANDIN_LOG: log }),
				cwd: work,
				log: join(runDir.dir, "headless.log"),
			},
		);
		assert.equal(result.code, 77, explain(result.text));
		assert.match(result.stderr, /^BLOCKED switchboard \(env:virtual\) is zone personal; this place/u, explain(result.stderr));
		assert.deepEqual(readRequests(log), [], explain("a stand-in model was asked"));
		assert.deepEqual(classifier.requests, [], explain("the classifier was asked"));
	});

	it("lets pi-switchboard fail over between members during a turn: the virtual model stays the account", async () => {
		const { pi } = await open("failover", personal, { models: { "alpha/mid": [{ error: "429 Too Many Requests: rate limit exceeded" }] } });
		const turn = await pi.prompt("fix the build");
		assert.deepEqual(
			turn.replies.map((reply) => `${reply.provider}/${reply.model}`),
			["alpha/mid", "beta/mid"],
			explain(JSON.stringify(turn.replies)),
		);
		assert.equal(turn.replies.at(-1)?.stopReason, "stop", explain(turn.notices));
		assert.doesNotMatch(turn.notices, /guard:/u, explain(turn.notices));
	});

	it("blocks a switch from switchboard/auto to a model of the other zone, as for any account", async () => {
		const { pi, requests } = await open("model-switch", personal);
		await pi.setModel("alpha", "mid");
		const from = pi.mark();
		await pi.submit("fix the build");
		assert.match(blockTitle(pi, from) ?? "", /^BLOCKED +alpha \(fallback\) is zone work/u, explain("no Block select"));
		assert.deepEqual(requests(), [], explain("alpha/mid was asked"));
	});
});
