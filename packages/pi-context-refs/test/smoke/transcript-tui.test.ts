// Opt-in: runs real pi in a pseudo-terminal (`npm run test:smoke`). A sent File Ref shows as one line per Context block
// in the live transcript while the model got the full text (DESIGN.md section 13), and `/ref sent` shows the full text.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { QUIET_REPLY } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const API_BODY = "API-BODY-MARKER\n</context-ref>\nSTILL-API-BODY-MARKER\n";
const NOTES_BODY = "NOTES-BODY-MARKER\n";

async function startTui(): Promise<{ tui: PtySession; run: ReturnType<typeof probeRun> }> {
	const run = probeRun("none", { STUB_QUIET: "1" });
	writeFileSync(join(run.dir, "api.txt"), API_BODY);
	writeFileSync(join(run.dir, "notes.txt"), NOTES_BODY);
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "pi-context-refs.json"),
		JSON.stringify({
			version: 1,
			refs: [
				{ name: "api", kind: "file", path: "api.txt" },
				{ name: "notes", kind: "file", path: "notes.txt" },
			],
		}),
	);
	const tui = new PtySession({ ...run.options, extensions: [EXTENSION], env: { ...run.options.env, PI_CODING_AGENT_DIR: agentDir } });
	await tui.ready();
	return { tui, run };
}

describe("the transcript of a sent File Ref", () => {
	it("shows one line per Context block while the model got the full text, and /ref sent shows the full text", async () => {
		const { tui, run } = await startTui();
		try {
			tui.type("check [ref:api] and [ref:notes]\r");
			const screen = await tui.waitForScreen((text) => text.includes("▸ ref notes (file,") && text.includes(QUIET_REPLY));
			const rows = screen.split("\n");
			const apiRow = rows.findIndex((row) => row.includes("▸ ref api (file, 53 B)"));
			const notesRow = rows.findIndex((row) => row.includes("▸ ref notes (file, 18 B)"));
			assert.ok(apiRow !== -1 && notesRow > apiRow, `one line per block, in order; the screen shows:\n${screen}`);
			assert.ok(screen.includes("check [ref:api] and [ref:notes]"), "the prose keeps its Placeholders");
			assert.ok(!screen.includes("API-BODY-MARKER") && !screen.includes("NOTES-BODY-MARKER"), "the bodies are not shown");
			assert.ok(!screen.includes("<context-ref"), "no block tag is shown");
			assert.ok(!tui.raw.includes("API-BODY-MARKER"), "the body was never drawn");
			const [received] = run.received();
			assert.ok(received?.text.includes("STILL-API-BODY-MARKER") && received.text.includes("NOTES-BODY-MARKER"), "the model got the full text");

			tui.type("/ref sent\r");
			const dialog = await tui.waitForScreen((text) => text.includes("Last message sent") && text.includes("STILL-API-BODY-MARKER"));
			assert.ok(dialog.includes("NOTES-BODY-MARKER") && dialog.includes("check [ref:api] and [ref:notes]"));
			tui.type("\x1b");
			await tui.waitForScreen((text) => !text.includes("Last message sent"));
		} finally {
			await tui.close();
		}
	});
});
