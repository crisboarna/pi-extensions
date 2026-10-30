// Opt-in: runs real pi in a pseudo-terminal (`npm run test:smoke`). alt+r opens the overlay (DESIGN.md section 7): a pick replaces the typed
// Trigger token, the preview shows the Expansion, and a removal goes through the same confirm as /ref remove.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { QUIET_REPLY } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const ALT_R = "\x1br";
const CTRL_D = "\x04";

async function startTui(): Promise<{ tui: PtySession; run: ReturnType<typeof probeRun>; library: string }> {
	const run = probeRun("none", { STUB_QUIET: "1" });
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	const library = join(agentDir, "pi-context-refs.json");
	writeFileSync(
		library,
		JSON.stringify({
			version: 1,
			refs: [
				{ name: "terse", kind: "snippet", text: "Answer in one sentence.", description: "Keep answers short" },
				{ name: "agents", kind: "path", path: "AGENTS.md" },
			],
		}),
	);
	const tui = new PtySession({ ...run.options, extensions: [EXTENSION], env: { ...run.options.env, PI_CODING_AGENT_DIR: agentDir } });
	await tui.ready();
	return { tui, run, library };
}

describe("the alt+r overlay in pi's editor", () => {
	it("opens over the typed Trigger, previews the Expansion, replaces the token on a pick, and the sent message is expanded", async () => {
		const { tui, run } = await startTui();
		try {
			tui.type("see #te");
			await tui.waitForScreen((screen) => screen.includes("● terse"));
			tui.type(ALT_R);
			const open = await tui.waitForScreen((screen) => screen.includes("Context refs") && screen.includes("── preview · terse"));
			assert.match(open, /filter: te/);
			assert.match(open, /enter inserts · ctrl\+e edits · ctrl\+d removes/);
			await tui.waitForScreen((screen) => screen.split("── preview · terse")[1]?.includes("Answer in one sentence.") === true);
			tui.type("\r");
			await tui.waitForScreen((screen) => screen.includes("see [ref:terse]") && !screen.includes("Context refs"));
			tui.type(" now\r");
			await tui.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(run.received(), [{ text: "see Answer in one sentence. now", images: 0 }]);
		} finally {
			await tui.close();
		}
	});

	it("removes a saved Ref after the confirm, and closes with Escape", async () => {
		const { tui, library } = await startTui();
		try {
			tui.type(ALT_R);
			await tui.waitForScreen((screen) => screen.includes("Context refs") && screen.includes("● agents"));
			tui.type("\x1b");
			await tui.waitForScreen((screen) => !screen.includes("Context refs"));
			tui.type(ALT_R);
			await tui.waitForScreen((screen) => screen.includes("Context refs"));
			tui.type(CTRL_D);
			await tui.waitForScreen((screen) => screen.includes('Remove "terse"?'));
			tui.type("\r");
			await tui.waitForScreen((screen) => screen.includes("Context refs") && !screen.includes("● terse") && screen.includes("● agents"));
			const refs = (JSON.parse(readFileSync(library, "utf8")) as { refs: Array<{ name: string }> }).refs;
			assert.deepEqual(
				refs.map((ref) => ref.name),
				["agents"],
			);
		} finally {
			await tui.close();
		}
	});
});
