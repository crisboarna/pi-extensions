// The technique ADR 0001 relies on, written as plainly as possible: merge spans of the
// text into single segments on top of the editor's own `segment`. Only the contract test
// uses it, to prove the technique works on the installed pi-tui.
import type { Editor } from "@earendil-works/pi-tui";

export interface Segment {
	segment: string;
	index: number;
	input: string;
	isWordLike?: boolean;
}

type SegmentFunction = (text: string, mode?: "grapheme" | "word") => Iterable<Segment>;

/** What pi-tui's Editor exposes for segmenting, which TypeScript marks private. */
export interface SegmentingEditor {
	segment: SegmentFunction;
}

/** The editor's segmenting member, read through the type the contract test checks. */
export function segmenting(editor: Editor): SegmentingEditor {
	return editor as unknown as SegmentingEditor;
}

/** Replaces the segments that start inside each span with one segment holding the span's text. */
export function mergeSpans(segments: Iterable<Segment>, text: string, spans: ReadonlyArray<{ start: number; end: number }>): Segment[] {
	const merged: Segment[] = [];
	for (const segment of segments) {
		const span = spans.find((candidate) => segment.index >= candidate.start && segment.index < candidate.end);
		if (!span) merged.push(segment);
		else if (segment.index === span.start) merged.push({ segment: text.slice(span.start, span.end), index: span.start, input: text });
	}
	return merged;
}

const PLACEHOLDER = /\[ref:[^\]\n]+\]/g;

/** Makes every `[ref:…]` in the editor's text one segment, on top of whatever `segment` the editor already has. */
export function installPlaceholderSegments(editor: Editor): void {
	const target = segmenting(editor);
	const base = target.segment.bind(editor);
	target.segment = (text, mode) => {
		const spans = [...text.matchAll(PLACEHOLDER)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
		return mergeSpans(base(text, mode), text, spans);
	};
}
