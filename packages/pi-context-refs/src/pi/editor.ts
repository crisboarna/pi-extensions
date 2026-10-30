import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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

/**
 * Decorates whichever editor is in the slot when the session starts, wrapping the editor factory instead of replacing it.
 * Another extension that later swaps the editor without wrapping ours removes the decoration; Placeholders are then plain text that still expands.
 */
export function registerEditor(pi: ExtensionAPI): void {
	let installed: EditorFactory | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const previous = ctx.ui.getEditorComponent();
		if (installed !== undefined && previous === installed) return;
		installed = (tui, theme, keybindings) => {
			const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
			decorateEditor(editor);
			return editor;
		};
		ctx.ui.setEditorComponent(installed);
	});
}
