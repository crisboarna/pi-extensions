import { placeholderSpans } from "./tokens.ts";

/** One piece of text as the editor's `segment` method reports it. */
export interface TextSegment {
	segment: string;
	index: number;
	input: string;
	isWordLike?: boolean;
}

/**
 * Merges the segments of each Placeholder into one, so the editor moves over it and deletes it as a unit.
 * A merged segment is not word-like, which makes Ctrl+W delete only the Placeholder.
 */
export function mergePlaceholderSegments(segments: Iterable<TextSegment>, text: string): Iterable<TextSegment> {
	const spans = placeholderSpans(text);
	if (spans.length === 0) return segments;
	const merged: TextSegment[] = [];
	let open: { span: (typeof spans)[number]; segment: TextSegment } | undefined;
	for (const segment of segments) {
		const span = spans.find((candidate) => segment.index >= candidate.start && segment.index < candidate.end);
		if (!span) {
			merged.push(segment);
			continue;
		}
		// A segment that starts inside the Placeholder but runs past its end (a combining mark after `]`) belongs to it.
		const end = Math.max(span.end, segment.index + segment.segment.length);
		if (open?.span === span) {
			open.segment.segment = text.slice(span.start, end);
			continue;
		}
		const whole = { segment: text.slice(span.start, end), index: span.start, input: text };
		merged.push(whole);
		open = { span, segment: whole };
	}
	return merged;
}
