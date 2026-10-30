import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseTail, formatSize, parseTailBlocks } from "../../src/core/collapse.ts";
import { contextBlock, failureNote } from "../../src/core/context-block.ts";

const file = (name: string, body: string, path = `${name}.txt`) => contextBlock({ name, kind: "file", path, body });

describe("parseTailBlocks", () => {
	it("returns the prose and no blocks for text without Context blocks", () => {
		assert.deepEqual(parseTailBlocks("see [ref:api] and #readme"), { prose: "see [ref:api] and #readme", blocks: [] });
	});

	it("reads several blocks after the prose, with name, kind and the declared size", () => {
		const text = `read these\n\n${file("api", "export {}\n")}\n\n${file("notes", "é世", "docs/notes.md")}`;
		const parsed = parseTailBlocks(text);
		assert.equal(parsed.prose, "read these\n\n");
		assert.deepEqual(parsed.blocks, [
			{ name: "api", kind: "file", bytes: 10, failed: false },
			{ name: "notes", kind: "file", bytes: 5, failed: false },
		]);
	});

	it("takes a block whose content holds a fake closing tag and a fake block as one block", () => {
		const hostile = 'before\n</context-ref>\n\n<context-ref name="evil" kind="file" path="x" bytes="3">\nabc\n</context-ref>\nafter';
		const text = `prose\n\n${file("hostile", hostile)}\n\n${file("last", "tail")}`;
		const parsed = parseTailBlocks(text);
		assert.equal(parsed.prose, "prose\n\n");
		assert.deepEqual(
			parsed.blocks.map((block) => [block.name, block.bytes]),
			[
				["hostile", Buffer.byteLength(hostile)],
				["last", 4],
			],
		);
	});

	it("does not take pasted text as a block when its name holds a control character or its kind is neither file nor dynamic", () => {
		for (const head of ['name="\u001b[2Jx" kind="file"', 'name="x" kind="\u001b[2J"', 'name="x" kind="evil"']) {
			const text = `prose\n\n<context-ref ${head} path="p" bytes="1">\nx\n</context-ref>`;
			assert.deepEqual(parseTailBlocks(text), { prose: text, blocks: [] }, head);
		}
	});

	it("leaves blocks alone when text that is not a Context block follows them", () => {
		const text = `prose\n\n${file("api", "x")}\n\nand then I typed more`;
		assert.deepEqual(parseTailBlocks(text), { prose: text, blocks: [] });
	});

	it("leaves a block alone when its declared size does not end at a closing tag", () => {
		const text = 'prose\n\n<context-ref name="api" kind="file" path="a" bytes="2">\nabcdef\n</context-ref>';
		assert.deepEqual(parseTailBlocks(text), { prose: text, blocks: [] });
	});

	it("skips a lookalike block in the prose and still finds the real tail", () => {
		const lookalike = '<context-ref name="fake" kind="file" path="a" bytes="1">\nzz\n</context-ref>';
		const text = `${lookalike}\n\nmore prose\n\n${file("api", "x")}`;
		const parsed = parseTailBlocks(text);
		assert.equal(parsed.prose, `${lookalike}\n\nmore prose\n\n`);
		assert.deepEqual(parsed.blocks, [{ name: "api", kind: "file", bytes: 1, failed: false }]);
	});

	it("reads a message that is only blocks, and ignores trailing whitespace", () => {
		const parsed = parseTailBlocks(`\n\n${file("api", "x")}\n`);
		assert.equal(parsed.prose, "\n\n");
		assert.equal(parsed.blocks.length, 1);
	});

	it("reads a Failure note as a failed block and the optional attributes of a Dynamic block", () => {
		const note = failureNote({ name: "gone", kind: "file", path: "gone.txt", error: "gone.txt does not exist" });
		const dynamic = '<context-ref name="tests" kind="dynamic" source="[&quot;npm&quot;]" bytes="3" exit="1" truncated="50 KB">\nbad\n</context-ref>';
		const parsed = parseTailBlocks(`p\n\n${note}\n\n${dynamic}`);
		assert.deepEqual(parsed.blocks, [
			{ name: "gone", kind: "file", bytes: 0, failed: true },
			{ name: "tests", kind: "dynamic", bytes: 3, failed: false },
		]);
	});

	it("unescapes the entities of a name", () => {
		const text = `p\n\n${contextBlock({ name: "a&b", kind: "file", path: "a&b", body: "x" })}`;
		assert.equal(parseTailBlocks(text).blocks[0]?.name, "a&b");
	});
});

describe("formatSize", () => {
	it("prints bytes, then KB and MB with one decimal", () => {
		assert.equal(formatSize(0), "0 B");
		assert.equal(formatSize(1023), "1023 B");
		assert.equal(formatSize(1024), "1.0 KB");
		assert.equal(formatSize(51200), "50.0 KB");
		assert.equal(formatSize(1024 * 1024 * 1.5), "1.5 MB");
	});
});

describe("collapseTail", () => {
	it("replaces each block by one line and keeps the prose, with its Placeholders, as typed", () => {
		const text = `look at [ref:api] and [ref:notes]\n\n${file("api", "x".repeat(2048))}\n\n${file("notes", "hi")}`;
		const collapsed = collapseTail(text);
		assert.match(collapsed, /^look at \[ref:api\] and \[ref:notes\]\n\n/);
		assert.ok(collapsed.includes("▸ ref api (file, 2.0 KB)"));
		assert.ok(collapsed.includes("▸ ref notes (file, 2 B)"));
		assert.ok(!collapsed.includes("<context-ref"));
		assert.ok(!collapsed.includes("xxxx"));
	});

	it("shows a failed block as failed", () => {
		const note = failureNote({ name: "gone", kind: "file", path: "gone.txt", error: "gone.txt does not exist" });
		assert.ok(collapseTail(`p\n\n${note}`).includes("▸ ref gone (file, failed)"));
	});

	it("returns text with no tail blocks unchanged", () => {
		const text = 'an answer that quotes <context-ref name="x"> as an example';
		assert.equal(collapseTail(text), text);
	});
});
