import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard, type GuardDeps } from "../../src/pi/hooks.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";
const personalAccount = { provider: "acme", source: "stored-key", zones: ["personal"] };
const workAccount = { provider: "acme", source: "stored-key", zones: ["work"] };
const prompt = (text = "hello") => ({ text, source: "interactive" });

function rig(config?: unknown, overrides: Partial<GuardDeps> = {}) {
	const host = createFakeHost();
	const state = { host, stderr: [] as string[], exitCodes: [] as number[], file: { text: config === undefined ? undefined : JSON.stringify(config) as string | undefined } };
	registerGuard(host.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: () => state.file.text,
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeStderr: (text) => void state.stderr.push(text),
		setExitCode: (code) => void state.exitCodes.push(code),
		...overrides,
	});
	return state;
}

const session = (options: Parameters<typeof createFakeSession>[0] = {}) => createFakeSession({ cwd: "/srv/app", ...options });

describe("a config that becomes malformed mid-session", () => {
	it("keeps deciding with the last valid copy and warns once", async () => {
		const state = rig({ accounts: [personalAccount] });
		const s = session({ hasUI: true });
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined);

		state.file.text = '{ "colour": 1 }';
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined, "the last valid copy still matches");
		assert.equal(await state.host.fire("input", prompt(), s.ctx), undefined);
		const warnings = s.notices.filter((notice) => notice.type === "warning");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!.message, /cannot read ~\/\.pi\/agent\/account-guard\.json; using the last valid copy/);
		assert.match(warnings[0]!.message, /account-guard\.json: unknown field "colour"/);
	});

	it("warns on stderr once without a UI and sets no exit code", async () => {
		const state = rig({ accounts: [personalAccount] });
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		state.file.text = "{ nope";
		await state.host.fire("input", prompt(), s.ctx);
		await state.host.fire("input", prompt(), s.ctx);
		assert.equal(state.stderr.length, 1);
		assert.match(state.stderr[0]!, /^guard: cannot read ~\/\.pi\/agent\/account-guard\.json; using the last valid copy/);
		assert.deepEqual(state.exitCodes, []);
	});

	it("sees the fixed file again", async () => {
		const state = rig({ accounts: [personalAccount] });
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		state.file.text = "{ nope";
		await state.host.fire("input", prompt(), s.ctx);
		state.file.text = JSON.stringify({ accounts: [workAccount] });
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.match(state.stderr.at(-1)!, /^BLOCKED acme \(stored-key\) is zone work/);
	});

	it("forgets the last valid copy on the next session_start", async () => {
		const state = rig({ accounts: [personalAccount] });
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		state.file.text = "{ nope";
		await state.host.fire("session_start", { reason: "new" }, s.ctx);
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.match(state.stderr.at(-1)!, /account-guard\.json: invalid JSON/);
	});
});

describe("a malformed config with no valid copy", () => {
	it("blocks every turn in the TUI, naming the file and the JSON path", async () => {
		const state = rig({ accounts: [{ provider: "acme", source: "stored-key", zones: [] }] });
		const s = session({ hasUI: true });
		const titles: string[] = [];
		(s.ctx.ui as { select: unknown }).select = async (title: string) => void titles.push(title);
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		for (const text of ["one", "two"]) {
			assert.deepEqual(await state.host.fire("input", prompt(text), s.ctx), { action: "handled" });
		}
		assert.equal(titles.length, 2);
		assert.match(titles[0]!, /cannot read account-guard\.json/);
		assert.match(titles[0]!, /account-guard\.json: accounts\[0\]\.zones: must list at least one zone/);
		assert.deepEqual(s.editorTexts, ["one", "two"]);
	});
});

describe("a missing config file", () => {
	it("is the default config: a place in the default zone and every account Unknown", async () => {
		const state = rig();
		const s = session();
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		assert.match(state.stderr[0]!, /has no zone tag; place zone is personal/);
	});
});

describe("a handler that throws", () => {
	const failing = { realpath: () => { throw new Error("disk on fire"); } };

	it("aborts, notifies and logs when session_start throws", async () => {
		const state = rig({ accounts: [personalAccount] }, failing);
		const s = session({ hasUI: true });
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(s.aborts, 1);
		assert.deepEqual(s.notices, [{ message: "guard: the session_start handler failed (disk on fire).", type: "error" }]);
		assert.deepEqual(state.host.entries, [{ customType: "guard.error", data: { handler: "session_start", reason: "disk on fire" } }]);
	});

	it("handles the input, notifies and logs when the check throws", async () => {
		const state = rig({ accounts: [personalAccount] }, failing);
		const s = session({ hasUI: true });
		assert.deepEqual(await state.host.fire("input", prompt("keep me"), s.ctx), { action: "handled" });
		assert.equal(s.notices.length, 1);
		assert.match(s.notices[0]!.message, /^BLOCKED: the guard failed \(disk on fire\)/);
		assert.deepEqual(s.editorTexts, ["keep me"]);
		assert.deepEqual(state.host.entries, [{ customType: "guard.error", data: { handler: "input", reason: "disk on fire" } }]);
	});

	it("still handles the input when the notice itself throws", async () => {
		const state = rig({ accounts: [personalAccount] }, failing);
		const s = session({ hasUI: true });
		s.ctx.ui.notify = () => {
			throw new Error("ui gone");
		};
		assert.deepEqual(await state.host.fire("input", prompt(), s.ctx), { action: "handled" });
		// One entry for the failed check, one for the failed notice.
		assert.deepEqual(state.host.entries.map((entry) => entry.data.handler), ["input", "input"]);
	});

	it("still aborts and notifies when the log entry cannot be written", async () => {
		const state = rig({ accounts: [personalAccount] }, failing);
		(state.host.pi as { appendEntry: unknown }).appendEntry = () => {
			throw new Error("log full");
		};
		const s = session({ hasUI: true });
		await state.host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(s.aborts, 1, "the run is still aborted");
		assert.equal(s.notices.length, 1, "and the user is still told");
	});
});
