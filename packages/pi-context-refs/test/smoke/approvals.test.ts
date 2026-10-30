// Opt-in: runs real pi (`npm run test:smoke`). A Project Dynamic Ref asks for an Approval through the RPC client's dialog, which the test answers only with
// extension_ui_response; print mode never asks and sends a Failure note with a hint on stderr (DESIGN.md sections 10.3 and 12).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type RpcRecord, RpcSession, runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;

/** A user whose project library holds a command Ref that writes a marker file when it runs. */
function user() {
	const probe = probeRun("none");
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(probe.dir, ".pi"));
	const marker = join(probe.dir, "ran.txt");
	const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('ran it')", marker];
	writeFileSync(join(probe.dir, ".pi", "pi-context-refs.json"), JSON.stringify({ version: 1, refs: [{ name: "setup", kind: "dynamic", command }] }));
	const options = { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } };
	const approvalsFile = join(agentDir, "pi-context-refs-approvals.json");
	return {
		options,
		received: probe.received,
		ran: () => existsSync(marker),
		approvals: () =>
			existsSync(approvalsFile) ? (JSON.parse(readFileSync(approvalsFile, "utf8")) as { approvals: Array<Record<string, string>> }).approvals : [],
		/** Sends `prompt` over RPC, answers the first dialog of `method` with `answer`, and waits for the turn to end. */
		async rpc(prompt: string, method: "select" | "confirm", answer: Record<string, unknown>) {
			const rpc = new RpcSession(options);
			try {
				rpc.send({ id: "p1", type: "prompt", message: prompt });
				const request = await rpc.waitFor(isUiRequest(method));
				assert.ok(!rpc.records.some((record) => record.type === "agent_start"), "the turn waits for the answer");
				rpc.send({ type: "extension_ui_response", id: request.id, ...answer });
				await rpc.waitFor((record) => record.type === "agent_settled" || (record.type === "response" && record.id === "p1"), 60_000);
				return request;
			} finally {
				await rpc.close();
			}
		},
	};
}

describe("a Project Dynamic Ref in real pi (DESIGN.md section 10.3)", () => {
	it("in print mode is not run: a Failure note, a hint on stderr, and no dialog", async () => {
		const me = user();
		const result = await runPrint("Set up: #setup", me.options);
		assert.equal(result.code, 0, result.stderr);
		assert.match(
			me.received()[0]?.text ?? "",
			/name="setup" kind="dynamic" source=".*" bytes="0" error="it is not approved; approve it in pi with \/ref approve setup"/,
		);
		assert.match(result.stderr, /pi-context-refs: #setup: it is not approved; approve it in pi with \/ref approve setup/);
		assert.equal(me.ran(), false);
	});

	it("in RPC asks through the client with the exact definition, and runs once on an answer of once", async () => {
		const me = user();
		const request = await me.rpc("Set up: #setup", "select", { value: "Run once" });
		assert.match(String(request.title), /^Allow the Project library Ref #setup to run this\?\nsource: command\nargv: .*ran\.txt\ncwd: /);
		assert.deepEqual(request.options, ["Run once", "Always for this definition", "Deny"]);
		assert.match(me.received()[0]?.text ?? "", /\$ .*ran\.txt\nran it\n/);
		assert.equal(me.ran(), true);
		assert.deepEqual(me.approvals(), []);
	});

	it("in RPC does not run on a deny: a Failure note and nothing stored", async () => {
		const me = user();
		await me.rpc("Set up: #setup", "select", { value: "Deny" });
		assert.match(me.received()[0]?.text ?? "", /error="you denied it"/);
		assert.equal(me.ran(), false);
		assert.deepEqual(me.approvals(), []);
	});

	it("in RPC does not run when the client cancels the dialog", async () => {
		const me = user();
		await me.rpc("Set up: #setup", "select", { cancelled: true });
		assert.match(me.received()[0]?.text ?? "", /error="you did not approve it"/);
		assert.equal(me.ran(), false);
	});

	it("keeps an answer of always, so print mode then runs the Ref without asking", async () => {
		const me = user();
		await me.rpc("Set up: #setup", "select", { value: "Always for this definition" });
		assert.equal(me.approvals().length, 1);
		assert.equal(me.approvals()[0]?.name, "setup");
		const result = await runPrint("Again: #setup", me.options);
		assert.equal(result.code, 0, result.stderr);
		assert.match(me.received().at(-1)?.text ?? "", /\$ .*ran\.txt\nran it\n/);
		assert.equal(result.stderr, "");
	});

	it("/ref approve over RPC asks a confirm and stores the Approval; print mode refuses to approve", async () => {
		const me = user();
		const refused = await runPrint("/ref approve setup", me.options);
		assert.match(refused.stderr, /needs a confirm in pi's UI/);
		assert.deepEqual(me.approvals(), []);
		const request = await me.rpc("/ref approve setup", "confirm", { confirmed: true });
		assert.equal(request.title, "Approve #setup?");
		assert.match(String(request.message), /source: command\nargv: .*ran\.txt\ncwd: /);
		assert.equal(me.approvals().length, 1);
		const listed = await runPrint("/ref list", me.options);
		assert.match(listed.stderr, /^ {2}setup {2}dynamic .*\(approved\)$/m);
	});
});

describe("a Project Dynamic Ref in the TUI (DESIGN.md section 10.3)", () => {
	it("shows the exact definition and the three choices, and runs on once", async () => {
		const me = user();
		const tui = new PtySession(me.options);
		try {
			await tui.ready();
			tui.type("Set up: #setup\r");
			const screen = await tui.waitForScreen((text) => text.includes("Run once") && text.includes("Deny"));
			assert.ok(screen.includes("Allow the Project library Ref #setup to run this?"), screen);
			assert.ok(screen.includes("source: command") && screen.includes("argv: ") && screen.includes("cwd: "), screen);
			assert.ok(screen.includes("Always for this definition"), screen);
			assert.equal(me.ran(), false, "nothing ran before the answer");
			tui.type("\r");
			await tui.waitForScreen((text) => text.includes("Set up:") && !text.includes("Run once"));
			for (let waited = 0; me.received().length === 0 && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
			assert.match(me.received()[0]?.text ?? "", /\$ .*ran\.txt\nran it\n/);
			assert.equal(me.ran(), true);
		} finally {
			await tui.close();
		}
	});

	it("puts the draft back when the answer is deny", async () => {
		const me = user();
		const tui = new PtySession(me.options);
		try {
			await tui.ready();
			tui.type("Set up: #setup\r");
			await tui.waitForScreen((text) => text.includes("Deny"));
			tui.type("\u001b[B\u001b[B\r");
			const screen = await tui.waitForScreen((text) => text.includes("you denied it"));
			assert.ok(screen.includes("Set up: #setup"), `the draft is back:\n${screen}`);
			assert.deepEqual(me.received(), []);
			assert.equal(me.ran(), false);
		} finally {
			await tui.close();
		}
	});
});
