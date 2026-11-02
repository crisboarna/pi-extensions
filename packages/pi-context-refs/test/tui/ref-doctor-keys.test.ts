// Layer B: /ref doctor in a real pi session on a virtual terminal. The report tells the person whether the Placeholder is one unit in the editor
// they are typing in, so it is checked against the editor pi really built: the package's own, and one another extension swapped in late.
//
// covers: src/pi/doctor.ts, src/pi/editor.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TuiSession } from "../support/tui-session.ts";

const REPORT = "pi-context-refs doctor:";
const LIBRARY = { version: 1, refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }] };

/** An extension that replaces the editor with a plain one 100 ms after the session starts, later than the package's wrap, without wrapping ours. */
function lateReplacer(swapped: { done: boolean }): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", (_event, ctx) => {
			setTimeout(() => {
				ctx.ui.setEditorComponent((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings));
				swapped.done = true;
			}, 100);
		});
	};
}

describe("/ref doctor under pi's real TUI", () => {
	it("reports the library and says a Placeholder is one unit when the package's editor is the one in use", async () => {
		const tui = await TuiSession.start({ library: LIBRARY });
		try {
			await tui.ready();
			const report = await tui.terminal.runCommand("/ref doctor", REPORT);
			assert.match(report, /✓\s+Global\s+library:\s+1\s+ref\s+in/);
			assert.match(report, /✓\s+editor:\s+a\s+placeholder\s+is\s+one\s+unit/);
			assert.match(report, /✓\s+trigger:\s+#\s+opens\s+the\s+list/);
			assert.doesNotMatch(report, /✗/);
		} finally {
			await tui.close();
		}
	});

	it("says another extension replaced the editor when one swaps it in after the wrap", async () => {
		const swapped = { done: false };
		const tui = await TuiSession.start({ library: LIBRARY, extensions: [lateReplacer(swapped)] });
		try {
			await tui.ready();
			while (!swapped.done) await new Promise((resolve) => setTimeout(resolve, 20));
			await new Promise((resolve) => setTimeout(resolve, 200));
			const report = await tui.terminal.runCommand("/ref doctor", REPORT);
			assert.match(report, /!\s+editor:\s+another\s+extension\s+replaced\s+it\s+after\s+the\s+wrap/);
			assert.doesNotMatch(report, /✓\s+editor:/);
		} finally {
			await tui.close();
		}
	});
});
