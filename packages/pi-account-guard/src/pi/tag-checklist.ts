import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ChecklistKey, createChecklist } from "../core/checklist.ts";

function keyOf(data: string): ChecklistKey | undefined {
	if (matchesKey(data, "up")) return "up";
	if (matchesKey(data, "down")) return "down";
	if (matchesKey(data, "space")) return "toggle";
	if (matchesKey(data, "enter")) return "submit";
	if (matchesKey(data, "escape")) return "cancel";
	return undefined;
}

/** Shows the zones as a checkbox list in the TUI; resolves with the checked zones, or `undefined` when the user cancels. */
export function askZonesWithChecklist(ctx: ExtensionContext, title: string, zones: string[]): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui, _theme, _keybindings, done) => {
		const list = createChecklist(title, zones);
		return {
			render: (width) => list.lines().flatMap((line) => wrapTextWithAnsi(line, width).map((wrapped) => truncateToWidth(wrapped, width))),
			handleInput(data) {
				const key = keyOf(data);
				if (key === undefined) return;
				const outcome = list.press(key);
				if (outcome) done(outcome.done);
				else tui.requestRender();
			},
			invalidate() {},
		};
	});
}
