import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePlaceholderSegments, type TextSegment } from "../../src/core/segments.ts";
import { placeholderSpans } from "../../src/core/tokens.ts";

/** What a grapheme segmenter reports: one segment per character. */
function graphemes(text: string): TextSegment[] {
	return [...text].map((segment, offset) => ({ segment, index: offset, input: text }));
}

const merged = (text: string, segments = graphemes(text)) => [...mergePlaceholderSegments(segments, text)].map(({ segment, index }) => [segment, index]);

describe("placeholderSpans", () => {
	it("finds every Placeholder form and no typed token", () => {
		const text = "a [ref:api] #terse [ref:./README.md] [ref:file:src/a.ts]";
		assert.deepEqual(
			placeholderSpans(text).map(({ start, end }) => text.slice(start, end)),
			["[ref:api]", "[ref:./README.md]", "[ref:file:src/a.ts]"],
		);
	});
});

describe("mergePlaceholderSegments", () => {
	it("returns the segments untouched when the text has no Placeholder", () => {
		const segments = graphemes("plain [text] #name");
		assert.equal(mergePlaceholderSegments(segments, "plain [text] #name"), segments);
	});

	it("merges each Placeholder into one segment at its own offset and keeps the rest", () => {
		assert.deepEqual(merged("a [ref:x] b[ref:y]"), [
			["a", 0],
			[" ", 1],
			["[ref:x]", 2],
			[" ", 9],
			["b", 10],
			["[ref:y]", 11],
		]);
	});

	it("keeps the editor's other fields off the merged segment, so it is not word-like", () => {
		const text = "[ref:x]";
		const [only] = mergePlaceholderSegments(
			graphemes(text).map((segment) => ({ ...segment, isWordLike: true })),
			text,
		);
		assert.deepEqual(only, { segment: "[ref:x]", index: 0, input: text });
	});

	it("takes in a combining mark that follows the closing bracket in the same segment", () => {
		const text = "[ref:x]\u0301!";
		const segments: TextSegment[] = [
			...graphemes("[ref:x").map((segment) => segment),
			{ segment: "]\u0301", index: 6, input: text },
			{ segment: "!", index: 8, input: text },
		];
		assert.deepEqual(merged(text, segments), [
			["[ref:x]\u0301", 0],
			["!", 8],
		]);
	});

	it("merges a path-form and a file-form Placeholder, whose targets hold punctuation", () => {
		assert.deepEqual(merged("[ref:./a b.md][ref:file:src/a.ts]"), [
			["[ref:./a b.md]", 0],
			["[ref:file:src/a.ts]", 14],
		]);
	});
});
