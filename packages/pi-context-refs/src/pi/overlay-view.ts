import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type PickerRow, withFileForm } from "../core/picker.ts";
import { drawable } from "./text-viewer.ts";

/** What the person did in the overlay. `pick` inserts the row; the others act on it and the overlay opens again. */
export type OverlayResult = { action: "close" } | { action: "pick" | "edit" | "remove" | "save"; row: PickerRow };

/** What the overlay keeps while it is closed for an edit, a removal or a save, so it opens again where it was. */
export interface OverlayState {
	filter: string;
	/** The key of the selected row (`rowKey`). */
	selected?: string;
	/** The paths of the Recent rows switched to file form. */
	fileForms: Set<string>;
}

/** The parts of pi's TUI the overlay uses. */
export interface OverlayTui {
	requestRender(): void;
	terminal: { rows: number };
}

export interface OverlayOptions {
	tui: OverlayTui;
	theme: Pick<Theme, "fg" | "bold">;
	done(result: OverlayResult): void;
	/** The rows that answer a filter (what was typed after the Trigger), as the inline list shows them. */
	rowsFor(filter: string): PickerRow[];
	/** The text of the row's Expansion. It stops when the signal aborts. */
	preview(row: PickerRow, signal: AbortSignal): Promise<string>;
	state: OverlayState;
	/** How long a row stays selected before its preview starts, so that a command is not run for every row the selection passes. */
	previewDelay: number;
}

const SECTION_TITLE = { scoped: "Scoped", project: "Project", global: "Global", builtin: "Built-in", recent: "Recent", bundle: "Bundles" };
const SAVED = new Set<PickerRow["section"]>(["scoped", "project", "global"]);

/** Fixed rows: title, filter, the preview rule, the hint and a spare. */
const CHROME_ROWS = 5;
const MIN_LIST_ROWS = 4;
const MIN_PREVIEW_ROWS = 3;

export const rowKey = (row: PickerRow): string => `${row.section}\u0000${row.name}`;

/** The sectioned list with a filter and a preview of the selected row's Expansion, opened with `alt+r`. */
export class PickerOverlay implements Focusable {
	private readonly input = new Input({ prompt: "filter: " });
	private rows: PickerRow[] = [];
	private index = 0;
	private top = 0;
	private notice: string | undefined;
	private preview: { key: string; text?: string } | undefined;
	private previewTimer: ReturnType<typeof setTimeout> | undefined;
	private previewRun: AbortController | undefined;
	private closed = false;
	private readonly options: OverlayOptions;

	constructor(options: OverlayOptions) {
		this.options = options;
		this.input.setValue(options.state.filter);
		this.refilter(options.state.selected);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	private get selectedRow(): PickerRow | undefined {
		return this.rows[this.index];
	}

	private applyForm(row: PickerRow): PickerRow {
		return row.path !== undefined && this.options.state.fileForms.has(row.path) ? withFileForm(row) : row;
	}

	private refilter(keep?: string): void {
		this.rows = this.options.rowsFor(this.input.getValue()).map((row) => this.applyForm(row));
		const kept = keep === undefined ? -1 : this.rows.findIndex((row) => rowKey(row) === keep);
		this.index = Math.max(kept, 0);
		this.options.state.filter = this.input.getValue();
		this.afterMove();
	}

	private afterMove(): void {
		const row = this.selectedRow;
		if (row) this.options.state.selected = rowKey(row);
		else delete this.options.state.selected;
		this.schedulePreview();
	}

	private move(to: number): void {
		this.index = Math.max(0, Math.min(to, this.rows.length - 1));
		this.afterMove();
	}

	private schedulePreview(): void {
		const row = this.selectedRow;
		const key = row?.value;
		const current = this.preview;
		if (current !== undefined && current.key === key && current.text !== undefined) return;
		clearTimeout(this.previewTimer);
		this.previewRun?.abort();
		this.preview = key === undefined ? undefined : { key };
		if (row === undefined || key === undefined) return;
		this.previewTimer = setTimeout(() => {
			const run = new AbortController();
			this.previewRun = run;
			this.options
				.preview(row, run.signal)
				.catch((error: unknown) => `could not preview: ${error instanceof Error ? error.message : String(error)}`)
				.then((text) => {
					if (run.signal.aborted || this.closed) return;
					this.preview = { key, text };
					this.options.tui.requestRender();
				});
		}, this.options.previewDelay);
	}

	private finish(result: OverlayResult): void {
		this.options.done(result);
	}

	private act(action: "edit" | "remove" | "save"): void {
		const row = this.selectedRow;
		if (row === undefined) return;
		if (action === "save") {
			if (row.section === "recent") this.finish({ action, row });
			else this.notice = "Only a Recent row can be saved as a Ref";
		} else if (SAVED.has(row.section)) {
			this.finish({ action, row });
		} else if (row.section === "builtin") {
			this.notice = `A Built-in Ref cannot be ${action === "edit" ? "edited" : "removed"}; a saved Ref with the same name shadows it`;
		} else {
			this.notice = `Only a saved Ref can be ${action === "edit" ? "edited" : "removed"}`;
		}
	}

	private toggleForm(): void {
		const row = this.selectedRow;
		if (row?.path === undefined) {
			this.notice = "Only a Recent row has a file form";
			return;
		}
		const { fileForms } = this.options.state;
		if (!fileForms.delete(row.path)) fileForms.add(row.path);
		this.refilter(rowKey(row));
	}

	handleInput(data: string): void {
		this.notice = undefined;
		const page = Math.max(1, this.listHeight() - 1);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.finish({ action: "close" });
		else if (matchesKey(data, "enter")) {
			const row = this.selectedRow;
			if (row) this.finish({ action: "pick", row });
		} else if (matchesKey(data, "up")) this.move(this.index - 1);
		else if (matchesKey(data, "down")) this.move(this.index + 1);
		else if (matchesKey(data, "pageUp")) this.move(this.index - page);
		else if (matchesKey(data, "pageDown")) this.move(this.index + page);
		else if (matchesKey(data, "tab")) this.toggleForm();
		else if (matchesKey(data, "ctrl+s")) this.act("save");
		else if (matchesKey(data, "ctrl+e")) this.act("edit");
		else if (matchesKey(data, "ctrl+d")) this.act("remove");
		else {
			this.input.handleInput(data);
			if (this.input.getValue() !== this.options.state.filter) this.refilter(this.options.state.selected);
		}
		this.options.tui.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.closed = true;
		clearTimeout(this.previewTimer);
		this.previewRun?.abort();
	}

	private available(): number {
		return Math.max(MIN_LIST_ROWS + MIN_PREVIEW_ROWS, this.options.tui.terminal.rows - CHROME_ROWS - 4);
	}

	private listHeight(): number {
		return Math.max(MIN_LIST_ROWS, Math.ceil(this.available() * 0.55));
	}

	private hint(): string {
		const row = this.selectedRow;
		const keys = ["enter inserts"];
		if (row?.section === "recent") keys.push("tab switches path and file form", "ctrl+s saves as a Ref");
		else if (row !== undefined && SAVED.has(row.section)) keys.push("ctrl+e edits", "ctrl+d removes");
		keys.push("esc closes");
		return keys.join(" · ");
	}

	/** The list as lines: a heading where the section changes, then the rows. `at` is the line of the selected row. */
	private listLines(width: number): { lines: string[]; at: number } {
		const lines: string[] = [];
		let at = 0;
		let section: PickerRow["section"] | undefined;
		for (const [position, row] of this.rows.entries()) {
			if (row.section !== section) {
				section = row.section;
				lines.push(this.options.theme.fg("dim", `── ${SECTION_TITLE[section]}`));
			}
			const selected = position === this.index;
			const text = `${selected ? "›" : " "} ${row.mark} ${row.name}  ${row.kind} · ${row.description}`;
			if (selected) at = lines.length;
			lines.push(
				selected ? this.options.theme.bold(this.options.theme.fg("accent", truncateToWidth(text, width, "…"))) : truncateToWidth(text, width, "…"),
			);
		}
		if (lines.length === 0) lines.push(this.options.theme.fg("dim", `No Ref answers "${this.input.getValue()}"`));
		return { lines, at };
	}

	private previewLines(width: number, height: number): string[] {
		const row = this.selectedRow;
		if (row === undefined) return [];
		const text = this.preview?.text;
		if (text === undefined) return [this.options.theme.fg("dim", "…")];
		// A long line wraps, since the end of a Context block's first line can be what matters (its `error`).
		const all = drawable(text)
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		return all.length > height ? [...all.slice(0, height - 1), this.options.theme.fg("dim", `… ${all.length - height + 1} more lines`)] : all;
	}

	render(width: number): string[] {
		const { theme } = this.options;
		const listHeight = this.listHeight();
		const previewHeight = Math.max(MIN_PREVIEW_ROWS, this.available() - listHeight);
		const list = this.listLines(width);
		this.top = Math.max(0, Math.min(this.top, list.at), list.at - listHeight + 1);
		const visible = list.lines.slice(this.top, this.top + listHeight);
		const preview = this.previewLines(width, previewHeight);
		const row = this.selectedRow;
		const rule = theme.fg("dim", `── preview${row ? ` · ${row.name}` : ""}`);
		const bottom = this.notice === undefined ? theme.fg("dim", this.hint()) : theme.fg("warning", this.notice);
		return [theme.bold("Context refs"), ...this.input.render(width), ...visible, rule, ...preview, bottom].map((line) => truncateToWidth(line, width, "…"));
	}
}
