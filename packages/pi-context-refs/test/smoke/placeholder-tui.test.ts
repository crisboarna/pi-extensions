// Opt-in: runs real pi in a pseudo-terminal (`npm run test:smoke`). A Placeholder in the real editor of the real TUI
// behaves as one unit (DESIGN.md section 6), and the message still reaches the model expanded.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { QUIET_REPLY } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const BACKSPACE = "\x7f";
const CTRL_W = "\x17";

async function startTui(): Promise<{ tui: PtySession; run: ReturnType<typeof probeRun> }> {
	const run = probeRun("none", { STUB_QUIET: "1" });
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "pi-context-refs.json"),
		JSON.stringify({ version: 1, refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }] }),
	);
	const tui = new PtySession({ ...run.options, extensions: [EXTENSION], env: { ...run.options.env, PI_CODING_AGENT_DIR: agentDir } });
	await tui.ready();
	return { tui, run };
}

describe("the Placeholder in pi's editor", () => {
	it("is deleted by one Backspace, leaves the word before it with Ctrl+W, and still expands when sent", async () => {
		const { tui, run } = await startTui();
		try {
			tui.type("first [ref:terse]");
			await tui.waitForScreen((screen) => screen.includes("first [ref:terse]"));
			tui.type(BACKSPACE);
			const afterBackspace = await tui.waitForScreen((screen) => screen.includes("first") && !screen.includes("[ref:"));
			assert.ok(!afterBackspace.includes("[ref:terse"), "no half of the Placeholder is left");

			tui.type("[ref:terse]");
			await tui.waitForScreen((screen) => screen.includes("first [ref:terse]"));
			tui.type(CTRL_W);
			await tui.waitForScreen((screen) => screen.includes("first") && !screen.includes("[ref:"));

			tui.type("[ref:terse] now\r");
			await tui.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(run.received(), [{ text: "first Answer in one sentence. now", images: 0 }]);
		} finally {
			await tui.close();
		}
	});
});
