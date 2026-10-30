import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions as TuiOverlayOptions } from "@earendil-works/pi-tui";
import { expandRefs } from "../core/expand.ts";
import { type PickerRow, type PickerSource, pickerRows, pickInsertion, placeholderText } from "../core/picker.ts";
import { isUsedProjectFile } from "../core/recent.ts";
import { readSettings } from "../core/ref-list.ts";
import { isNumber, triggerQuery } from "../core/trigger.ts";
import { createPreviewApprover } from "./approvals.ts";
import { type CommandDeps, edit, remove } from "./commands.ts";
import type { Draft, EditorTap } from "./editor.ts";
import type { InputDeps } from "./input.ts";
import { createLibraries, type Libraries } from "./libraries.ts";
import { type OverlayResult, type OverlayState, PickerOverlay } from "./overlay-view.ts";
import { pickerSourceOf } from "./picker.ts";
import { createRun } from "./ref-run.ts";
import { saveUsedFile } from "./ref-save.ts";

/** What the overlay needs from outside pi: everything a send needs to preview an Expansion, and everything `/ref` needs to edit, remove and save. */
export interface OverlayDeps extends InputDeps, CommandDeps {
	/** Whether the path is a file that exists; a Recent row for a file that is gone is hidden. */
	isFile: (path: string) => boolean;
}

/** How long a row stays selected before its preview starts. */
const PREVIEW_DELAY_MS = 150;

const SHAPE: TuiOverlayOptions = { width: "80%", minWidth: 50, maxHeight: "90%", anchor: "center" };

/** One session's overlay: the Trigger it started with, and the open overlay if there is one. */
interface OverlaySession {
	trigger: string;
	libraries: Libraries;
	/** False once the session has shut down. */
	active: boolean;
	/** Closes the open overlay. */
	close?: (() => void) | undefined;
}

/** The typed Trigger token that ends at the cursor, as the inline list claims it: not a number. */
function typedTrigger(draft: Draft | undefined, trigger: string): { typed: string; query: string } {
	if (draft === undefined) return { typed: "", query: "" };
	const { line, col } = draft.cursor();
	const query = triggerQuery((draft.lines()[line] ?? "").slice(0, col), trigger);
	return query === undefined || isNumber(query) ? { typed: "", query: "" } : { typed: `${trigger}${query}`, query };
}

/** The text of what a row would send, read the way a send reads it; a Project library command or URL Ref runs only when it is approved already. */
async function previewOf(ctx: ExtensionContext, deps: OverlayDeps, source: PickerSource, row: PickerRow, signal: AbortSignal): Promise<string> {
	const expansion = await expandRefs(placeholderText(row), source.visible, {
		...deps,
		cwd: ctx.cwd,
		usedFile: (path) => isUsedProjectFile(path, ctx.cwd, deps.recent, deps.realpath),
		layers: source.layers,
		approve: createPreviewApprover(ctx, deps),
		signal,
	});
	return expansion.text;
}

/** Puts the picked row in the draft in place of the typed Trigger token; into a draft it cannot read, at the cursor. */
function insert(ctx: ExtensionContext, trigger: string, tap: EditorTap, row: PickerRow): void {
	const draft = tap.draft(ctx);
	if (draft === undefined) {
		const lines = ctx.ui.getEditorText().split("\n");
		const text = pickInsertion(lines, lines.length - 1, (lines.at(-1) ?? "").length, row.value, "")?.text ?? "";
		if (text !== "") ctx.ui.pasteToEditor(text);
		return;
	}
	const { typed } = typedTrigger(draft, trigger);
	const { line, col } = draft.cursor();
	const insertion = pickInsertion(draft.lines(), line, col, row.value, typed);
	if (insertion) draft.replaceBeforeCursor(typed, insertion.text);
}

/** Edits, removes or saves what the person chose, with the dialogs and the confirm of `/ref`. */
async function act(ctx: ExtensionContext, deps: OverlayDeps, result: Exclude<OverlayResult, { action: "close" | "pick" }>): Promise<void> {
	const run = createRun(ctx, deps, (text, level = "info") => ctx.ui.notify(text, level));
	if (result.action === "edit") return edit(run, { name: "edit", refName: result.row.name, fields: [] });
	if (result.action === "remove") return remove(run, { name: "remove", refName: result.row.name });
	return saveUsedFile(run, result.row.name);
}

async function inWorkTree(deps: OverlayDeps, cwd: string): Promise<boolean> {
	try {
		return await deps.isGitWorkTree(cwd);
	} catch {
		return false;
	}
}

/** Opens the overlay and keeps opening it after an edit, a removal or a save, until the person picks or closes it. */
async function showOverlay(session: OverlaySession, ctx: ExtensionContext, deps: OverlayDeps, tap: EditorTap): Promise<void> {
	let repaint = (): void => {};
	const state: OverlayState = { filter: typedTrigger(tap.draft(ctx), session.trigger).query, fileForms: new Set() };
	while (session.active) {
		const source = pickerSourceOf(ctx, session.libraries, deps, deps.now().getTime(), await inWorkTree(deps, ctx.cwd));
		const result = await ctx.ui.custom<OverlayResult>(
			(tui, theme, _keybindings, done) => {
				repaint = () => tui.requestRender();
				session.close = () => done({ action: "close" });
				return new PickerOverlay({
					tui,
					theme,
					done,
					state,
					rowsFor: (filter) => pickerRows(source, filter),
					preview: (row, signal) => previewOf(ctx, deps, source, row, signal),
					previewDelay: PREVIEW_DELAY_MS,
				});
			},
			{ overlay: true, overlayOptions: SHAPE },
		);
		session.close = undefined;
		if (!session.active || result.action === "close") return;
		if (result.action === "pick") {
			insert(ctx, session.trigger, tap, result.row);
			// The editor does not ask for a repaint when text is inserted from outside a key press.
			repaint();
			return;
		}
		await act(ctx, deps, result);
	}
}

/**
 * Registers `alt+r`, which opens a sectioned overlay in the TUI: the rows of the inline list with a filter and a preview of the selected row's
 * Expansion. A pick replaces the typed Trigger token; Recent rows can switch to file form and be saved; saved rows can be edited and removed.
 */
export function registerOverlay(pi: ExtensionAPI, deps: OverlayDeps, tap: EditorTap): void {
	let session: OverlaySession | undefined;
	let open = false;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		let text: string | undefined;
		try {
			text = deps.readText(deps.libraryPath);
		} catch {
			text = undefined;
		}
		session = { trigger: readSettings(text).trigger, libraries: createLibraries(deps), active: true };
	});

	pi.on("session_shutdown", () => {
		if (!session) return;
		session.active = false;
		session.close?.();
	});

	pi.registerShortcut("alt+r", {
		description: "Pick a context Ref in an overlay, with a preview",
		handler: async (ctx) => {
			if (!session?.active || open || ctx.mode !== "tui") return;
			open = true;
			try {
				await showOverlay(session, ctx, deps, tap);
			} finally {
				open = false;
			}
		},
	});
}
