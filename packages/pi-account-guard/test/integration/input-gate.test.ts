import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard, type GuardDeps } from "../../src/pi/hooks.ts";
import { createFakeHost, createFakeSession, type FakeAuth } from "../support/fake-pi.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";

interface Rig {
	host: ReturnType<typeof createFakeHost>;
	stderr: string[];
	exitCodes: number[];
	/** The config file text; `undefined` is a missing file. */
	file: { text: string | undefined };
	links: Record<string, string>;
}

function rig(config?: unknown, overrides: Partial<GuardDeps> = {}): Rig {
	const host = createFakeHost();
	const state: Rig = { host, stderr: [], exitCodes: [], file: { text: config === undefined ? undefined : JSON.stringify(config) }, links: {} };
	registerGuard(host.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: () => state.file.text,
		realpath: (path) => state.links[path] ?? path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeStderr: (text) => void state.stderr.push(text),
		setExitCode: (code) => void state.exitCodes.push(code),
		...overrides,
	});
	return state;
}

const workAccount = { provider: "acme", source: "stored-key", zones: ["work"] };
const personalAccount = { provider: "acme", source: "stored-key", zones: ["personal"] };
const session = (options: Parameters<typeof createFakeSession>[0] = {}) => createFakeSession({ cwd: "/srv/app", ...options });
const prompt = (text = "hello") => ({ text, source: "interactive" });

describe("input gate, headless", () => {
	it("lets a turn on a matching account run and prints nothing", async () => {
		const state = rig({ accounts: [personalAccount] });
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined);
		assert.deepEqual(state.stderr, []);
		assert.deepEqual(state.exitCodes, []);
		assert.deepEqual(s.notices, []);
	});

	it("blocks a tagged account that does not match: handled, message on stderr, exit code 77", async () => {
		const state = rig({ accounts: [workAccount] });
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.equal(state.stderr.length, 1);
		assert.match(state.stderr[0]!, /^BLOCKED acme \(stored-key\) is zone work; this place\n\(\/srv\/app\) is zone personal\. No turn was sent\./);
		assert.match(state.stderr[0]!, /Fix, any one of:/);
		assert.deepEqual(state.exitCodes, [77]);
		assert.deepEqual(s.notices, []);
	});

	it("blocks an untagged account when the config file is missing", async () => {
		const state = rig();
		const s = session();
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.match(state.stderr[0]!, /^BLOCKED acme \(stored-key\) has no zone tag; place zone is personal\./);
		assert.deepEqual(state.exitCodes, [77]);
	});

	it("tells the same provider id apart by auth source", async () => {
		const state = rig({ accounts: [personalAccount] });
		const login: FakeAuth = { usingOAuth: true, status: { configured: true, source: "stored" } };
		const env: FakeAuth = { status: { configured: true, source: "environment", label: "ACME_KEY" } };
		assert.equal(await state.host.fire("input", prompt(), session().ctx), undefined, "stored-key is tagged");
		assert.deepEqual(await state.host.fire("input", prompt(), session({ auth: login }).ctx), { action: "handled" });
		assert.match(state.stderr[0]!, /^BLOCKED acme \(oauth\) has no zone tag/);
		assert.deepEqual(await state.host.fire("input", prompt(), session({ auth: env }).ctx), { action: "handled" });
		assert.match(state.stderr[1]!, /^BLOCKED acme \(env:ACME_KEY\) has no zone tag/);
	});

	it("checks text that starts with / like any other prompt", async () => {
		const state = rig({ accounts: [workAccount] });
		assert.deepEqual(await state.host.fire("input", prompt("/skill:review the diff"), session().ctx), { action: "handled" });
		assert.deepEqual(state.exitCodes, [77]);
	});

	it("gates every input source", async () => {
		const state = rig({ accounts: [workAccount] });
		for (const source of ["interactive", "rpc", "extension"]) {
			assert.deepEqual(await state.host.fire("input", { text: "x", source }, session().ctx), { action: "handled" }, source);
		}
	});

	it("does nothing when no model is selected", async () => {
		const state = rig({ accounts: [workAccount] });
		assert.equal(await state.host.fire("input", prompt(), session({ model: null }).ctx), undefined);
		assert.deepEqual(state.stderr, []);
		assert.deepEqual(state.exitCodes, []);
	});

	it("resolves the place through path rules and the real path of the cwd", async () => {
		const state = rig({ accounts: [workAccount], places: [{ path: "/data/co", zone: "work" }] });
		state.links["/home/me/co-link"] = "/data/co";
		const s = session({ cwd: "/home/me/co-link/api" });
		state.links["/home/me/co-link/api"] = "/data/co/api";
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined, "a symlinked cwd matches the rule on its real path");
	});

	it("caches the place zone at session start but reads tags live", async () => {
		const state = rig({ accounts: [workAccount], places: [{ path: "/srv", zone: "work" }] });
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined);

		state.file.text = JSON.stringify({ accounts: [workAccount], places: [] });
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined, "a rule edit waits for the next session_start");

		state.file.text = JSON.stringify({ accounts: [personalAccount], places: [] });
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" }, "a tag edit is seen at once");

		await state.host.fire("session_start", { reason: "reload" }, s.ctx);
		state.file.text = JSON.stringify({ accounts: [workAccount], places: [] });
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" }, "after the reload the place is personal again");
	});

	it("blocks every turn and names the file error when the config is invalid", async () => {
		const state = rig();
		state.file.text = "{ not json";
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.match(state.stderr[0]!, /cannot read ~\/\.pi\/agent\/account-guard\.json/);
		assert.match(state.stderr[0]!, /account-guard\.json: invalid JSON/);
		assert.deepEqual(state.exitCodes, [77]);
	});

	it("blocks when the config file cannot be read", async () => {
		const state = rig(undefined, {
			readConfigText: () => {
				throw new Error("EACCES");
			},
		});
		assert.deepEqual(await state.host.fire("input", prompt(), session().ctx), { action: "handled" });
		assert.match(state.stderr[0]!, /cannot read the file: EACCES/);
	});

	it("blocks and names the cause when the place cannot be resolved", async () => {
		const state = rig({ accounts: [personalAccount] }, { realpath: () => undefined });
		assert.deepEqual(await state.host.fire("input", prompt(), session().ctx), { action: "handled" });
		assert.match(state.stderr[0]!, /cannot decide this place's zone \(cannot resolve the real path of \/srv\/app\)/);
		assert.deepEqual(state.exitCodes, [77]);
	});

	it("blocks instead of failing open when its own code throws", async () => {
		const state = rig({ accounts: [personalAccount] }, {
			realpath: () => {
				throw new Error("disk on fire");
			},
		});
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.match(state.stderr.at(-1)!, /^BLOCKED: the guard failed \(disk on fire\)/);
		assert.deepEqual(state.exitCodes, [77]);
	});
});

describe("input gate, with a UI", () => {
	it("opens the Block select, and refills the editor and sets no exit code on Cancel", async () => {
		const state = rig({ accounts: [workAccount] });
		const s = session({ hasUI: true });
		const titles: string[] = [];
		s.ctx.ui.select = async (title: string) => void titles.push(title);
		assert.deepEqual(await state.host.fire("input", prompt("my prompt"), s.ctx), { action: "handled" });
		assert.match(titles[0]!, /^BLOCKED {2}acme \(stored-key\) is zone work/);
		assert.deepEqual(s.editorTexts, ["my prompt"]);
		assert.deepEqual(state.stderr, []);
		assert.deepEqual(state.exitCodes, []);
	});
});
