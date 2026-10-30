// Opt-in: runs real pi in a pseudo-terminal (`npm run test:smoke`). The Trigger opens pi's autocomplete list of Refs (DESIGN.md
// section 7), a pick inserts a Placeholder, and the message still reaches the model expanded.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { QUIET_REPLY } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");

async function startTui(settings: Record<string, unknown> = {}): Promise<{ tui: PtySession; run: ReturnType<typeof probeRun> }> {
	const run = probeRun("none", { STUB_QUIET: "1" });
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "pi-context-refs.json"),
		JSON.stringify({
			version: 1,
			...settings,
			refs: [
				{ name: "terse", kind: "snippet", text: "Answer in one sentence.", description: "Keep answers short" },
				{ name: "agents", kind: "path", path: "AGENTS.md" },
			],
		}),
	);
	const tui = new PtySession({ ...run.options, extensions: [EXTENSION], env: { ...run.options.env, PI_CODING_AGENT_DIR: agentDir } });
	await tui.ready();
	return { tui, run };
}

describe("the # picker in pi's editor", () => {
	it("opens on #, inserts a Placeholder on a pick, and the sent message is expanded", async () => {
		const { tui, run } = await startTui();
		try {
			tui.type("#");
			const open = await tui.waitForScreen((screen) => screen.includes("● terse") && screen.includes("● agents"));
			assert.match(open, /● terse\s+snippet · Keep answers short/);
			tui.type("\t");
			await tui.waitForScreen((screen) => screen.includes("[ref:terse]") && !screen.includes("● agents"));
			tui.type(" now\r");
			await tui.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(run.received(), [{ text: "Answer in one sentence. now", images: 0 }]);
		} finally {
			await tui.close();
		}
	});

	it("narrows on #text and claims nothing for a token no Ref matches", async () => {
		const { tui } = await startTui();
		try {
			tui.type("#ag");
			const narrowed = await tui.waitForScreen((screen) => screen.includes("● agents"));
			assert.ok(!narrowed.includes("● terse"));
			tui.type("x");
			await tui.waitForScreen((screen) => screen.includes("#agx") && !screen.includes("● agents"));
		} finally {
			await tui.close();
		}
	});

	it("follows the trigger setting", async () => {
		const { tui } = await startTui({ trigger: "%" });
		try {
			tui.type("%");
			await tui.waitForScreen((screen) => screen.includes("● terse"));
		} finally {
			await tui.close();
		}
	});
});
