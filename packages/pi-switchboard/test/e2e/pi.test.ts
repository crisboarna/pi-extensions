// End to end, no model server: the repository's pinned pi with pi-switchboard
// installed from a freshly packed tarball, as `pi install npm:` installs it,
// asked `/tier doctor` and `/tier eval` with classifiers that cannot answer
// (`npm run test:e2e`; CI runs it too).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Installed, installTarball } from "./support/install.ts";
import { PiSession } from "./support/pi-rpc.ts";
import { isolatedEnv, type Run, startRun } from "./support/run.ts";

/** A local classifier on a port nothing listens on. */
const DEAD_LOCAL = {
	classifierProviders: [{ name: "local", baseUrl: "http://127.0.0.1:9/v1/", models: ["judge"] }],
	classifiers: [{ model: "local/judge", timeoutMs: 1000, threshold: 0.8 }],
};
/** A classifier from pi's own catalog, which runs off this machine. */
const REMOTE = "openai/gpt-6-luna";

let runDir: Run;
let installed: Installed;
const sessions: PiSession[] = [];

before(async () => {
	runDir = startRun("pi");
	installed = await installTarball(runDir);
});

after(async () => {
	for (const session of sessions) await session.close();
});

/** Starts pi with `config` as pi-switchboard's config (none when undefined), and `extra` in its environment. */
async function pi(name: string, config?: unknown, extra: Record<string, string> = {}): Promise<PiSession> {
	const path = join(runDir.dir, `${name}.json`);
	if (config !== undefined) writeFileSync(path, JSON.stringify(config, null, "\t"));
	const env = isolatedEnv(installed.home, { PI_CODING_AGENT_DIR: installed.agentDir, PI_SWITCHBOARD_CONFIG: path, ...extra });
	const session = await PiSession.start({ env, cwd: installed.home, log: join(runDir.dir, `pi-${name}`) });
	sessions.push(session);
	return session;
}

/** Fails if pi printed load errors or an extension handler threw. */
function assertClean(session: PiSession): void {
	assert.deepEqual(session.errors, [], runDir.explain("an extension handler threw"));
	assert.doesNotMatch(session.stderr, /Failed to load extension|Error:/u, runDir.explain(`pi's stderr:\n${session.stderr}`));
}

const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern.source, "gu"))?.length ?? 0;

describe("pi-switchboard in real pi, installed from the tarball, with no server", () => {
	it("loads with no config, says so once, and doctor names what is missing", async () => {
		const session = await pi("unconfigured");
		assert.match(session.notices.map((notice) => notice.message).join("\n"), /pi-switchboard is installed but not configured yet\./u);
		const doctor = await session.command("/tier doctor");
		assert.match(doctor, /^pi-switchboard doctor: 2 problem\(s\), 0 warning\(s\)$/mu);
		assert.match(doctor, /^✗ no config yet: run \/tier init/mu);
		assert.match(doctor, /^✗ no classifier configured: .*pi-switchboard classifier detect/mu);
		assertClean(session);
	});

	it("names a local classifier that does not answer once, with the server hint", async () => {
		const session = await pi("dead-local", DEAD_LOCAL);
		const doctor = await session.command("/tier doctor");
		assert.match(doctor, /^pi-switchboard doctor: 1 problem\(s\), 0 warning\(s\)$/mu);
		assert.match(
			doctor,
			/^✗ classifier local\/judge did not answer \(fetch failed\): is its server running\? `pi-switchboard classifier detect` shows what is$/mu,
		);
		assert.equal(count(doctor, /local\/judge/u), 1, runDir.explain(`named more than once:\n${doctor}`));
		assertClean(session);
	});

	it("stops /tier eval at the first failure, and checks its arguments", async () => {
		const session = await pi("dead-eval", DEAD_LOCAL);
		const evaluated = await session.command("/tier eval");
		assert.match(evaluated, /^local\/judge did not answer: fetch failed\nThe other 23 requests were not asked\.$/mu);
		assert.equal(count(evaluated, /did not answer/u), 1, runDir.explain(`repeated:\n${evaluated}`));
		assert.equal(
			await session.command("/tier eval nope/model"),
			"nope/model is not a classifier pi knows, or it has no credentials. /tier doctor lists what is registered.",
		);
		assert.equal(await session.command("/tier eval --threshold 7"), "--threshold must be a number from 0 to 1");
		assertClean(session);
	});

	it("skips a remote classifier without allowRemote, and warns once at start and once in doctor", async () => {
		const session = await pi("remote", { classifiers: [{ model: REMOTE, timeoutMs: 3000, threshold: 0.8 }] });
		const startup = session.notices.map((notice) => notice.message).join("\n");
		assert.equal(count(startup, /runs off this machine and is skipped/u), 1, runDir.explain(`startup:\n${startup}`));
		const doctor = await session.command("/tier doctor");
		assert.match(doctor, /^pi-switchboard doctor: 0 problem\(s\), 1 warning\(s\)$/mu);
		assert.match(doctor, new RegExp(`^! classifier ${REMOTE} is remote and skipped: set allowRemote: true`, "mu"));
		assert.equal(count(doctor, new RegExp(REMOTE, "u")), 1, runDir.explain(`named more than once:\n${doctor}`));
		assertClean(session);
	});

	it("says pi's own llama.cpp provider does not list a chat classifier whose router is not running", async () => {
		const session = await pi(
			"llama-missing",
			{ classifiers: [{ model: "llama.cpp/some-chat-model", timeoutMs: 3000, threshold: 0.8 }] },
			{ LLAMA_BASE_URL: "http://127.0.0.1:9" },
		);
		const doctor = await session.command("/tier doctor");
		assert.match(
			doctor,
			/^✗ classifier llama\.cpp\/some-chat-model is not listed by pi's llama\.cpp provider: is its server running with the model loaded\? Then run \/tier doctor again$/mu,
		);
		assert.doesNotMatch(doctor, /check classifierProviders/u);
		assertClean(session);
	});

	it("points a remote classifier with no key to its key, in doctor and in eval", async () => {
		const session = await pi("remote-no-key", { classifiers: [{ model: REMOTE, allowRemote: true, timeoutMs: 3000, threshold: 0.8 }] });
		const doctor = await session.command("/tier doctor");
		assert.match(doctor, new RegExp(`^✗ classifier ${REMOTE} did not answer \\(Provider is not configured: openai\\): check its key: `, "mu"));
		assert.match(doctor, /docs\/classifier-cloud\.md\)$/mu);
		const evaluated = await session.command("/tier eval");
		assert.match(evaluated, new RegExp(`^${REMOTE} did not answer: Provider is not configured: openai\\nThe other 23 requests were not asked\\.$`, "mu"));
		assertClean(session);
	});
});
