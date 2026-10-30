import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { mergePlaceholderSegments, type TextSegment } from "../core/segments.ts";

/** pi-tui's `Editor.segment`, which TypeScript marks private and the Placeholder's atomic behaviour builds on (ADR 0001). */
interface SegmentingEditor {
	segment(text: string, granularity?: "grapheme" | "word"): Iterable<TextSegment>;
}

/** pi's editor factory, which its package entry point does not export by name. */
export type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/** What pi's `ui.getEditorComponent` factories return. */
type EditorComponent = ReturnType<EditorFactory>;

const decorated = new WeakSet<EditorComponent>();

/** The draft in the editor, as the overlay reads and changes it. */
export interface Draft {
	lines(): string[];
	cursor(): { line: number; col: number };
	/** Deletes the typed token (`typed`, which ends at the cursor) with Backspace, then inserts `text` at the cursor. */
	replaceBeforeCursor(typed: string, text: string): void;
}

type DraftEditor = EditorComponent & {
	getLines(): string[];
	getCursor(): { line: number; col: number };
	insertTextAtCursor(text: string): void;
};

function isDraftEditor(editor: EditorComponent): editor is DraftEditor {
	return (
		"getLines" in editor &&
		typeof editor.getLines === "function" &&
		"getCursor" in editor &&
		typeof editor.getCursor === "function" &&
		"insertTextAtCursor" in editor &&
		typeof editor.insertTextAtCursor === "function"
	);
}

const BACKSPACE = "\x7f";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The editor's draft, or undefined when the editor cannot report its lines and cursor and insert text (pi's own editor can). */
export function draftOf(editor: EditorComponent): Draft | undefined {
	if (!isDraftEditor(editor)) return undefined;
	return {
		lines: () => editor.getLines(),
		cursor: () => editor.getCursor(),
		replaceBeforeCursor(typed, text) {
			for (const _ of graphemes.segment(typed)) editor.handleInput(BACKSPACE);
			if (text !== "") editor.insertTextAtCursor(text);
		},
	};
}

function isSegmenting(editor: EditorComponent): editor is EditorComponent & SegmentingEditor {
	return "segment" in editor && typeof editor.segment === "function";
}

/** Makes every Placeholder in the editor one unit. Returns false, touching nothing, when the editor has no `segment` method to build on. */
export function decorateEditor(editor: EditorComponent): boolean {
	if (!isSegmenting(editor)) return false;
	if (decorated.has(editor)) return true;
	const base = editor.segment.bind(editor);
	editor.segment = (text, granularity) => mergePlaceholderSegments(base(text, granularity), text);
	decorated.add(editor);
	return true;
}

/** Finds the draft of the editor the user types in. */
export interface EditorTap {
	/** The draft of the editor this package put in the slot, or undefined once something else holds the slot or the editor cannot report its draft. */
	draft(ctx: Pick<ExtensionContext, "ui">): Draft | undefined;
}

/**
 * Decorates whichever editor is in the slot when the session starts, wrapping the editor factory instead of replacing it.
 * Another extension that later swaps the editor without wrapping ours removes the decoration; Placeholders are then plain text that still expands.
 */
export function registerEditor(pi: ExtensionAPI): EditorTap {
	let installed: EditorFactory | undefined;
	let live: EditorComponent | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const previous = ctx.ui.getEditorComponent();
		if (installed !== undefined && previous === installed) return;
		installed = (tui, theme, keybindings) => {
			const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
			decorateEditor(editor);
			live = editor;
			return editor;
		};
		ctx.ui.setEditorComponent(installed);
	});
	return { draft: (ctx) => (live !== undefined && installed !== undefined && ctx.ui.getEditorComponent() === installed ? draftOf(live) : undefined) };
}
