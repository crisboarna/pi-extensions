// Opt-in: runs real pi in a pseudo-terminal (`npm run test:smoke`). The assumptions in DESIGN.md
// section 16.1 that only the interactive TUI can show.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROBE_BODY } from "../support/probe-extension.ts";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { QUIET_REPLY, REPLY_PREFIX } from "../support/stub-provider.ts";

/** Starts the TUI and waits until its editor takes input. */
async function startTui(scenario: string): Promise<{ tui: PtySession; run: ReturnType<typeof probeRun> }> {
	const run = probeRun(scenario, { STUB_QUIET: "1" });
	const tui = new PtySession(run.options);
	await tui.ready();
	return { tui, run };
}

describe("registerMarkdownTransformer (DESIGN.md section 13)", () => {
	it("receives messageType and rewrites the tail of a user message in the live transcript, while the model gets the full text", async () => {
		const { tui, run } = await startTui("transformer");
		try {
			tui.type("look at the probe\r");
			const screen = await tui.waitForScreen((text) => text.includes("▸ ref probe (file, 14 B)") && text.includes(QUIET_REPLY));
			assert.ok(screen.includes("look at the probe"), "the prose before the block stays");
			assert.ok(!screen.includes(PROBE_BODY), "the block's content is not shown");
			assert.ok(!tui.raw.includes(PROBE_BODY), "the block's content was never drawn");
			assert.ok(!screen.includes("<context-ref"), "the block's tags are not shown");
			assert.ok(
				run.received().every((received) => received.text.includes(PROBE_BODY)),
				"the model got the full block",
			);
			const transforms = run.observations().filter((entry) => entry.ran === "transform");
			const user = transforms.find((entry) => entry.messageType === "user");
			assert.ok(user, "the transformer ran for the user message");
			assert.match(String(user.markdown), /^look at the probe\n\n<context-ref name="probe"/);
			assert.ok(
				transforms.some((entry) => entry.messageType === "assistant"),
				"it also ran for the assistant message, with its own messageType",
			);
		} finally {
			await tui.close();
		}
	});
});

describe("input returning handled with ctx.ui.setEditorText (DESIGN.md section 12)", () => {
	it("puts the draft back in the editor and sends no turn", async () => {
		const { tui, run } = await startTui("handled-refill");
		try {
			tui.type("my draft\r");
			const screen = await tui.waitForScreen((text) => text.includes("RESTORED my draft"));
			assert.ok(screen.includes("Probe: draft restored"), "the reason is shown beside the restored draft");
			assert.deepEqual(run.received(), [], "no request reached the model");
			assert.ok(!tui.raw.includes(REPLY_PREFIX));
		} finally {
			await tui.close();
		}
	});
});
