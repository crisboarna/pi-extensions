// Contract test for ADR 0001: the Placeholder is made atomic by merging segments on top of
// pi-tui's private `Editor.prototype.segment`. This runs on every build, against the pi-tui the
// repository pins, so a pi upgrade that breaks the technique turns CI red instead of degrading
// the Placeholder to plain text for users. Do not weaken it to make an upgrade pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "@earendil-works/pi-tui";
import { EditorHarness } from "../support/editor-harness.ts";
import { installPlaceholderSegments, type Segment, segmenting } from "../support/segment-merge.ts";

const KEYS = { backspace: "\x7f", left: "\x1b[D", right: "\x1b[C", ctrlW: "\x17", undo: "\x1f", home: "\x01" };
const BIG_PASTE = Array.from({ length: 12 }, (_, line) => `pasted line ${line}`).join("\n");
const PASTE_MARKER = "[paste #1 +12 lines]";

function paste(harness: EditorHarness, text: string): void {
	harness.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

const texts = (segments: Iterable<Segment>) => [...segments].map((segment) => segment.segment);

describe("pi-tui Editor.prototype.segment", () => {
	it("exists as a method taking text and a mode", () => {
		const method: unknown = (Editor.prototype as unknown as Record<string, unknown>).segment;
		assert.equal(typeof method, "function");
		assert.equal((method as (...args: unknown[]) => unknown).length, 2, "segment(text, mode)");
	});

	it("returns an iterable of { segment, index, input } objects for both modes", () => {
		const editor = new EditorHarness([]).editor;
		const text = "ab 👍🏽";
		for (const mode of ["grapheme", "word"] as const) {
			const segments = [...segmenting(editor).segment(text, mode)];
			assert.ok(segments.length > 0);
			for (const segment of segments) {
				assert.equal(typeof segment.segment, "string");
				assert.equal(typeof segment.index, "number");
				assert.equal(segment.input, text);
				assert.equal(text.slice(segment.index, segment.index + segment.segment.length), segment.segment, "index locates the segment in the text");
			}
		}
		assert.deepEqual(texts(segmenting(editor).segment(text, "grapheme")), ["a", "b", " ", "👍🏽"]);
	});

	it("keeps pi's own paste marker as one segment in both modes", () => {
		const harness = new EditorHarness([]);
		paste(harness, BIG_PASTE);
		assert.equal(harness.text, PASTE_MARKER);
		const text = `see ${PASTE_MARKER} now`;
		for (const mode of ["grapheme", "word"] as const) {
			assert.ok(texts(segmenting(harness.editor).segment(text, mode)).includes(PASTE_MARKER), `${mode}: the marker is one segment`);
		}
	});
});

describe("merging Placeholder segments on top of segment", () => {
	async function draft(text: string, options: { withPaste?: boolean; merged?: boolean } = {}): Promise<EditorHarness> {
		const harness = new EditorHarness([]);
		if (options.merged !== false) installPlaceholderSegments(harness.editor);
		if (options.withPaste) paste(harness, BIG_PASTE);
		await harness.type(text);
		return harness;
	}

	it("is needed: without it one Backspace deletes one character of a Placeholder", async () => {
		const harness = await draft("see [ref:api]", { merged: false });
		await harness.press(KEYS.backspace);
		assert.equal(harness.text, "see [ref:api");
	});

	it("makes one Backspace delete the whole Placeholder", async () => {
		const harness = await draft("see [ref:api]");
		await harness.press(KEYS.backspace);
		assert.equal(harness.text, "see ");
	});

	it("makes the cursor skip over the Placeholder in one move, in both directions", async () => {
		const harness = await draft("[ref:api]x");
		await harness.press(KEYS.left);
		await harness.press(KEYS.left);
		await harness.type("Y");
		assert.equal(harness.text, "Y[ref:api]x", "two moves left cross the x and the whole Placeholder");
		await harness.press(KEYS.right);
		await harness.type("Z");
		assert.equal(harness.text, "Y[ref:api]Zx");
	});

	it("makes Ctrl+W after a Placeholder delete only the Placeholder", async () => {
		const harness = await draft("word [ref:api]");
		await harness.press(KEYS.ctrlW);
		assert.equal(harness.text, "word ");
	});

	it("brings the Placeholder back whole on undo", async () => {
		const harness = await draft("see [ref:api]");
		await harness.press(KEYS.backspace);
		await harness.press(KEYS.undo);
		assert.equal(harness.text, "see [ref:api]");
	});

	it("keeps pi's paste marker atomic beside a Placeholder", async () => {
		const harness = await draft(" [ref:api] ", { withPaste: true });
		assert.equal(harness.text, `${PASTE_MARKER} [ref:api] `);
		for (const mode of ["grapheme", "word"] as const) {
			const segments = texts(segmenting(harness.editor).segment(harness.text, mode));
			assert.ok(segments.includes(PASTE_MARKER), `${mode}: the paste marker is still one segment`);
			assert.ok(segments.includes("[ref:api]"), `${mode}: the Placeholder is one segment`);
		}
		await harness.press(KEYS.home);
		await harness.press(KEYS.right);
		await harness.press(KEYS.backspace);
		assert.equal(harness.text, " [ref:api] ", "one Backspace after the paste marker deletes it whole");
	});

	it("leaves text that has no Placeholder as the editor segments it", async () => {
		const harness = await draft("plain [text]");
		await harness.press(KEYS.backspace);
		assert.equal(harness.text, "plain [text");
	});
});
