// Opt-in: runs real pi (`npm run test:smoke`). File Refs reach the model as Context blocks (print), a failed one
// becomes a Failure note and a notification (RPC), and in the TUI it cancels the send and restores the draft (pty).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RpcSession, runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { replyFor } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const REFS = [
	{ name: "api", kind: "file", path: "src/api.ts" },
	{ name: "empty", kind: "file", path: "src/empty.txt" },
	{ name: "gone", kind: "file", path: "src/gone.ts" },
	{ name: "dir", kind: "file", path: "src" },
];
const API = "export const api = 1;\n";
const block = (attributes: string, body: string) => `<context-ref ${attributes}>\n${body}\n</context-ref>`;
const API_BLOCK = block('name="api" kind="file" path="src/api.ts" bytes="22"', API);
const GONE_NOTE = block('name="gone" kind="file" path="src/gone.ts" bytes="0" error="src/gone.ts does not exist"', "");

/** A run of the real extension in a project with `src/api.ts` and `src/empty.txt`, and a library of File Refs in its agent directory. */
function run(env: Record<string, string> = {}, refs: unknown[] = REFS) {
	const probe = probeRun("none", env);
	mkdirSync(join(probe.dir, "src"));
	writeFileSync(join(probe.dir, "src", "api.ts"), API);
	writeFileSync(join(probe.dir, "src", "empty.txt"), "");
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
	return { ...probe, options: { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } } };
}

describe("a File Ref in print mode (DESIGN.md sections 8 and 9)", () => {
	it("reaches the model as a Context block after the prose, with the Placeholder still in the prose", async () => {
		const probe = run();
		const result = await runPrint("Review [ref:api] and #empty, #api again.", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const text = `Review [ref:api] and #empty, #api again.\n\n${API_BLOCK}\n\n${block('name="empty" kind="file" path="src/empty.txt" bytes="0"', "")}`;
		assert.deepEqual(probe.received(), [{ text, images: 0 }]);
		assert.equal(result.stdout.trim(), replyFor({ text, images: 0 }));
		assert.equal(result.stderr, "");
	});

	it("sends a File member of a #tag:<tag> Bundle as a Context block, once", async () => {
		const probe = run({}, [
			{ name: "api", kind: "file", path: "src/api.ts", tags: ["Ctx"] },
			{ name: "terse", kind: "snippet", text: "Be brief.", tags: ["ctx"] },
		]);
		const result = await runPrint("Review #tag:ctx and #api.", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: `Review Be brief. and #api.\n\n${API_BLOCK}`, images: 0 }]);
		assert.equal(result.stderr, "");
	});

	it("sends a Failure note and warns on stderr when the file is missing", async () => {
		const probe = run();
		const result = await runPrint("Look at #gone", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: `Look at #gone\n\n${GONE_NOTE}`, images: 0 }]);
		assert.equal(result.stderr, "pi-context-refs: #gone: src/gone.ts does not exist\n");
	});

	it("fails a directory with a hint", async () => {
		const probe = run();
		const result = await runPrint("Look at #dir", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stderr, /^pi-context-refs: #dir: src is a directory; save it as a Path Ref, or as a Dynamic Ref that runs \["ls", \.\.\.\]\n$/);
	});
});

describe("a File Ref in RPC mode (DESIGN.md section 12)", () => {
	it("sends a Failure note and notifies the client, for a prompt and a follow-up", async () => {
		const probe = run({ STUB_DELAY_MS: "700" });
		const rpc = new RpcSession(probe.options);
		try {
			rpc.send({ id: "p1", type: "prompt", message: "first #gone" });
			const notice = await rpc.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify");
			assert.equal(notice.message, "pi-context-refs: #gone: src/gone.ts does not exist");
			assert.equal(notice.notifyType, "warning");
			await rpc.waitFor((record) => record.type === "agent_start");
			rpc.send({ id: "f1", type: "follow_up", message: "then #api" });
			await rpc.waitFor((record) => record.type === "agent_settled", 60_000);
			assert.deepEqual(
				probe.received().map((received) => received.text),
				[`first #gone\n\n${GONE_NOTE}`, `then #api\n\n${API_BLOCK}`],
			);
			assert.ok(
				!rpc.records.some((record) => record.type === "extension_ui_request" && record.method === "set_editor_text"),
				"RPC does not restore a draft",
			);
		} finally {
			await rpc.close();
		}
	});
});

describe("a File Ref in the TUI (DESIGN.md section 12)", () => {
	it("cancels the send for a missing file, puts the draft back in the editor and shows the reason", async () => {
		const probe = run({ STUB_QUIET: "1" });
		const tui = new PtySession(probe.options);
		try {
			await tui.ready();
			tui.type("Look at #gone\r");
			const screen = await tui.waitForScreen((text) => text.includes("src/gone.ts does not exist"));
			assert.ok(screen.includes("Look at #gone"), `the draft is back:\n${screen}`);
			assert.deepEqual(probe.received(), [], "no request reached the model");
			tui.type("!");
			await tui.waitForScreen((text) => text.includes("Look at #gone!"));
		} finally {
			await tui.close();
		}
	});

	it("sends the file to the model when it can be read", async () => {
		const probe = run({ STUB_QUIET: "1" });
		const tui = new PtySession(probe.options);
		try {
			await tui.ready();
			tui.type("Look at #api\r");
			await tui.waitForScreen(() => probe.received().length === 1);
			assert.deepEqual(probe.received(), [{ text: `Look at #api\n\n${API_BLOCK}`, images: 0 }]);
		} finally {
			await tui.close();
		}
	});
});
