import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { attachTagDialogs, KEY } from "../support/tag-dialogs.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";
const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const ENV = { PI_ACCOUNT_GUARD_ALLOW_UNKNOWN: "1" };

interface RigOptions {
	mode: "print" | "json" | "rpc" | "tui";
	env?: Record<string, string>;
	file?: string;
}

function rig({ mode, env = ENV, file }: RigOptions) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/srv/app", hasUI: mode === "rpc" || mode === "tui", model: acmeMid });
	const dialogs = attachDialogs(host, session, [acmeMid]);
	const tag = attachTagDialogs(session, mode);
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	const files = { text: file, writes: [] as string[] };
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		env,
		readConfigText: () => files.text,
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeConfigText: (_path, text) => void files.writes.push(text),
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
	});
	const input = (text = "my prompt") => host.fire("input", { text, source: "interactive" }, session.ctx);
	const entries = (type: string) => host.entries.filter((entry) => entry.customType === type);
	return { host, session, dialogs, tag, stderr, exitCodes, files, input, entries };
}

describe("process Override (PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1)", () => {
	for (const mode of ["print", "json"] as const) {
		it(`lets an Unknown account through in ${mode} mode, logs each turn and warns once on stderr`, async () => {
			const r = rig({ mode });
			assert.equal(await r.input(), undefined);
			assert.equal(await r.input(), undefined);
			assert.equal(r.entries("guard.allow_unknown").length, 2);
			assert.deepEqual(r.entries("guard.allow_unknown")[0]!.data, {
				account: { provider: "acme", source: "stored-key" },
				cause: "unknown-account",
				place: { path: "/srv/app", zone: "personal" },
			});
			assert.equal(r.stderr.length, 1);
			assert.match(
				r.stderr[0]!,
				/^guard: PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 lets turns through to accounts with no zone tag, starting with acme \(stored-key\)\./,
			);
			assert.deepEqual(r.exitCodes, []);
			assert.equal(r.entries("guard.block").length, 0);
		});
	}

	it("logs and warns for a turn that starts without input, such as sendMessage with triggerTurn", async () => {
		const r = rig({ mode: "print" });
		await r.host.fire("before_agent_start", { messageType: "custom" }, r.session.ctx);
		await r.host.fire("before_agent_start", { messageType: "custom" }, r.session.ctx);
		assert.equal(r.session.aborts, 0);
		assert.equal(r.entries("guard.allow_unknown").length, 2);
		assert.equal(r.stderr.length, 1);
		assert.deepEqual(r.exitCodes, []);
	});

	it("logs a turn once when it passes input and before_agent_start, and the next input-less turn again", async () => {
		const r = rig({ mode: "print" });
		assert.equal(await r.input(), undefined);
		await r.host.fire("before_agent_start", { messageType: "user" }, r.session.ctx);
		await r.host.fire("agent_end", {}, r.session.ctx);
		assert.equal(r.entries("guard.allow_unknown").length, 1);
		await r.host.fire("before_agent_start", { messageType: "custom" }, r.session.ctx);
		assert.equal(r.entries("guard.allow_unknown").length, 2);
	});

	it("lets an Unknown account through over RPC with no dialog, and warns once with a notice", async () => {
		const r = rig({ mode: "rpc" });
		assert.equal(await r.input(), undefined);
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.selects.length, 0);
		assert.deepEqual(r.files.writes, []);
		assert.equal(r.entries("guard.allow_unknown").length, 2);
		assert.deepEqual(
			r.session.notices.map((notice) => notice.type),
			["warning"],
		);
		assert.deepEqual(r.stderr, []);
	});

	it("warns again in a new session", async () => {
		const r = rig({ mode: "print" });
		await r.input();
		await r.host.fire("session_start", { reason: "new" }, r.session.ctx);
		await r.input();
		assert.equal(r.stderr.length, 2);
	});

	it("is ignored in the TUI, which still shows the Tag prompt", async () => {
		const r = rig({ mode: "tui" });
		r.tag.customKeys.push([KEY.escape]);
		r.dialogs.selectAnswers.push(/^Cancel$/);
		assert.deepEqual(await r.input(), { action: "handled" });
		assert.equal(r.tag.customFrames.length, 1);
		assert.equal(r.entries("guard.allow_unknown").length, 0);
		assert.deepEqual(r.session.notices, []);
	});

	it("does nothing for a value other than 1 or without the variable", async () => {
		for (const env of [{} as Record<string, string>, { PI_ACCOUNT_GUARD_ALLOW_UNKNOWN: "0" }, { PI_ACCOUNT_GUARD_ALLOW_UNKNOWN: "true" }]) {
			const r = rig({ mode: "print", env });
			assert.deepEqual(await r.input(), { action: "handled" });
			assert.match(r.stderr[0]!, /^BLOCKED acme \(stored-key\) has no zone tag/);
			assert.deepEqual(r.exitCodes, [77]);
		}
	});

	it("never lets through a tagged account that fails to Match, in print or RPC", async () => {
		const file = JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }] });
		const print = rig({ mode: "print", file });
		assert.deepEqual(await print.input(), { action: "handled" });
		assert.match(print.stderr[0]!, /^BLOCKED acme \(stored-key\) is zone work/);
		assert.deepEqual(print.exitCodes, [77]);
		assert.equal(print.entries("guard.allow_unknown").length, 0);

		const rpc = rig({ mode: "rpc", file });
		rpc.dialogs.selectAnswers.push(/^Cancel$/);
		assert.deepEqual(await rpc.input(), { action: "handled" });
		assert.match(rpc.dialogs.selects[0]!.title, /is zone work/);
		assert.equal(rpc.entries("guard.allow_unknown").length, 0);
	});

	it("never lets through an undecidable case", async () => {
		const r = rig({ mode: "print", file: "{ nope" });
		assert.deepEqual(await r.input(), { action: "handled" });
		assert.match(r.stderr[0]!, /^BLOCKED acme \(stored-key\): cannot read/);
		assert.deepEqual(r.exitCodes, [77]);
		assert.equal(r.entries("guard.allow_unknown").length, 0);
	});

	it("does not write the config file", async () => {
		const r = rig({ mode: "print" });
		await r.input();
		assert.deepEqual(r.files.writes, []);
	});
});
