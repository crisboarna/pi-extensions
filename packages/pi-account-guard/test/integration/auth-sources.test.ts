import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { pooledProviders } from "../../src/pi/pooled.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { attachTagDialogs } from "../support/tag-dialogs.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";
const HELPER_COMMAND = "/opt/secret-tool --token hunter2";

const bridge: FakeModel = { provider: "claude-bridge", id: "big", auth: { status: { configured: true, source: "runtime" } } };
const pooled: FakeModel = { provider: "pool", id: "mid", pooled: true };
const virtual: FakeModel = { provider: "route", id: "auto" };

interface RigOptions {
	model: FakeModel;
	/** The guard config text; `undefined` is a missing file. */
	file?: string;
	env?: Record<string, string | undefined>;
	/** File texts by path, besides the guard config. */
	files?: Record<string, string>;
}

/** A guard in a personal place (the default zone) with a session on `model`. */
function rig({ model, file, env = {}, files = {} }: RigOptions) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/srv/app", hasUI: true, model });
	const dialogs = attachDialogs(host, session, [model, bridge, pooled, virtual]);
	attachTagDialogs(session, "rpc");
	const state = { config: file as string | undefined, writes: [] as string[] };
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		env,
		readConfigText: (path) => (path === CONFIG_PATH ? state.config : files[path]),
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeConfigText: (_path, text) => {
			state.writes.push(text);
			state.config = text;
		},
		writeStderr: () => undefined,
		setExitCode: () => undefined,
	});
	const input = () => host.fire("input", { text: "my prompt", source: "interactive" }, session.ctx);
	return { host, session, dialogs, state, input };
}

const taggedFile = (provider: string, source: string, zone: string) =>
	JSON.stringify({ zones: ["work", "personal"], defaultZone: "personal", accounts: [{ provider, source, zones: [zone] }], places: [] });

describe("claude-bridge account", () => {
	it("keeps the environment of each registration, so a second guard in the same process does not change the first", async () => {
		const file = taggedFile("claude-bridge", "claude-config:~/.claude-personal", "personal");
		const personal = rig({ model: bridge, file, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-personal" } });
		const work = rig({ model: bridge, file, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" } });
		assert.equal(await personal.input(), undefined, "the first guard still resolves its own directory");
		work.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		assert.deepEqual(await work.input(), { action: "handled" });
	});

	it("tags a work and a personal Claude Code config directory as different Accounts", async () => {
		const file = taggedFile("claude-bridge", "claude-config:~/.claude-personal", "personal");
		const personal = rig({ model: bridge, file, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-personal" } });
		assert.equal(await personal.input(), undefined, "the tagged personal directory matches");

		const work = rig({ model: bridge, file, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" } });
		work.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await work.input();
		assert.equal(work.dialogs.selects[0]!.title, "This place is personal. Which zones does claude-bridge · Claude Code login ~/.claude-work belong to?");
	});

	it("resolves an environment key to env:<VAR> and tags that", async () => {
		const r = rig({ model: bridge, env: { ANTHROPIC_API_KEY: "sk-secret" } });
		r.dialogs.selectAnswers.push(/^personal$/);
		assert.equal(await r.input(), undefined);
		assert.deepEqual(JSON.parse(r.state.config!).accounts, [{ provider: "claude-bridge", source: "env:ANTHROPIC_API_KEY", zones: ["personal"] }]);
		assert.equal(r.dialogs.selects[0]!.title.includes("sk-secret"), false);
	});

	it("Blocks with the tag prompt when the source changes under the same provider id", async () => {
		const file = taggedFile("claude-bridge", "claude-config:~/.claude", "personal");
		const before = rig({ model: bridge, file });
		assert.equal(await before.input(), undefined);

		const after = rig({ model: bridge, file, env: { ANTHROPIC_API_KEY: "sk-secret" } });
		after.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		assert.deepEqual(await after.input(), { action: "handled" });
		assert.equal(
			after.dialogs.selects[0]!.title,
			"This place is personal. Which zones does claude-bridge · environment variable ANTHROPIC_API_KEY belong to?",
		);
		assert.match(after.dialogs.selects[1]!.title, /^BLOCKED {2}claude-bridge \(env:ANTHROPIC_API_KEY\) has no zone tag/);
	});

	it("shows a cloud provider setup as the generic Claude Code cloud login", async () => {
		const r = rig({ model: bridge, env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await r.input();
		assert.equal(r.dialogs.selects[0]!.title, "This place is personal. Which zones does claude-bridge · Claude Code cloud login belong to?");
	});

	it("maps an apiKeyHelper setup to claude-code and never keeps or shows the helper command", async () => {
		const settings = JSON.stringify({ apiKeyHelper: HELPER_COMMAND, env: { SOME_KEY: "hunter2" } });
		const r = rig({ model: bridge, files: { "/home/me/.claude/settings.json": settings } });
		r.dialogs.selectAnswers.push(/^personal$/);
		assert.equal(await r.input(), undefined);
		assert.deepEqual(JSON.parse(r.state.config!).accounts, [{ provider: "claude-bridge", source: "claude-code", zones: ["personal"] }]);
		const shown = JSON.stringify([r.dialogs.selects, r.session.notices, r.state.writes, r.host.entries]);
		assert.equal(shown.includes("hunter2"), false);
		assert.equal(shown.includes("secret-tool"), false);
	});

	it("keeps a malformed settings file from breaking the check", async () => {
		const r = rig({ model: bridge, files: { "/home/me/.claude/settings.json": "{ nope" } });
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await r.input();
		assert.match(r.dialogs.selects[0]!.title, /claude-bridge · Claude Code login ~\/\.claude belong to\?$/);
	});

	it("does not give another provider id the claude-bridge resolver", async () => {
		const other: FakeModel = { provider: "acme", id: "mid" };
		const r = rig({ model: other, env: { ANTHROPIC_API_KEY: "sk-secret" } });
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await r.input();
		assert.match(r.dialogs.selects[0]!.title, /acme · saved API key/);
	});
});

describe("pooled provider", () => {
	const POOL_WARNING = "pool pools several accounts (pi-multiprovider). Tag it only if all of them share one zone.";

	it("warns in the tag prompt", async () => {
		const r = rig({ model: pooled });
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await r.input();
		assert.equal(r.dialogs.selects[0]!.title, `This place is personal. Which zones does pool · saved API key belong to?\n${POOL_WARNING}`);
	});

	it("does not warn for a provider that is not pooled", async () => {
		const r = rig({ model: { provider: "acme", id: "mid" } });
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await r.input();
		assert.equal(r.dialogs.selects[0]!.title.includes("pools"), false);
	});

	it("is listed from the model registry, once per id", () => {
		const r = rig({ model: pooled });
		assert.deepEqual(pooledProviders(r.session.ctx), ["pool"]);
	});

	it("never Blocks by itself once tagged for the zone of the place", async () => {
		const r = rig({ model: pooled, file: taggedFile("pool", "stored-key", "personal") });
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.selects.length, 0);
		assert.deepEqual(r.session.notices, []);
	});
});

describe("virtual routing model", () => {
	it("allows a turn when tagged for the zone of the place", async () => {
		const r = rig({ model: virtual, file: taggedFile("route", "stored-key", "personal") });
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.selects.length, 0);
	});

	it("Blocks a turn when tagged for another zone", async () => {
		const r = rig({ model: virtual, file: taggedFile("route", "stored-key", "work") });
		r.dialogs.selectAnswers.push(/^Cancel$/);
		assert.deepEqual(await r.input(), { action: "handled" });
		assert.equal(r.dialogs.selects[0]!.title, "BLOCKED  route (stored-key) is zone work\nPlace /srv/app -> zone personal");
	});
});
