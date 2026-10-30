import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const CHROME_ROWS = 4;
const MIN_TEXT_ROWS = 3;

/** Text safe to draw: control characters other than a line feed are dropped and a tab becomes spaces. */
function drawable(text: string): string {
	return text.replace(/\t/g, "    ").replace(/(?![\n])\p{Cc}/gu, "");
}

/** Shows `text` in a read-only dialog that scrolls; it resolves when the person closes it. */
export function showReadOnlyText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const source = drawable(text);
		let top = 0;
		let visibleRows = MIN_TEXT_ROWS;
		let rowCount = 0;
		const scrollTo = (row: number): void => {
			top = Math.max(0, Math.min(row, rowCount - visibleRows));
			tui.requestRender();
		};
		return {
			render(width) {
				const rows = source.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)));
				rowCount = rows.length;
				visibleRows = Math.max(MIN_TEXT_ROWS, tui.terminal.rows - CHROME_ROWS);
				top = Math.max(0, Math.min(top, rowCount - visibleRows));
				const shown = rows.slice(top, top + visibleRows);
				const range = rowCount > visibleRows ? ` (${top + 1}-${top + shown.length} of ${rowCount})` : "";
				const hint = theme.fg("dim", `${rowCount > visibleRows ? "up/down, PgUp/PgDn, Home/End scroll, " : ""}Esc closes${range}`);
				return [theme.bold(title), "", ...shown.map((row) => ` ${row}`), "", hint].map((line) => truncateToWidth(line, width));
			},
			handleInput(data) {
				if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") done();
				else if (matchesKey(data, "up")) scrollTo(top - 1);
				else if (matchesKey(data, "down")) scrollTo(top + 1);
				else if (matchesKey(data, "pageUp")) scrollTo(top - visibleRows);
				else if (matchesKey(data, "pageDown")) scrollTo(top + visibleRows);
				else if (matchesKey(data, "home")) scrollTo(0);
				else if (matchesKey(data, "end")) scrollTo(rowCount);
			},
			invalidate() {},
		};
	});
}
