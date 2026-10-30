import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextBlock, failureNote, namesWithBlock, sanitizeText } from "../../src/core/context-block.ts";

describe("sanitizeText", () => {
	it("removes a byte order mark at the start and nothing else", () => {
		assert.equal(sanitizeText(new TextEncoder().encode("\uFEFFhello\uFEFF")), "hello\uFEFF");
	});

	it("strips control characters, including escape sequences and NUL, and keeps tab, newline and carriage return", () => {
		assert.equal(sanitizeText(new TextEncoder().encode("a\x1b[31mred\x00\x07\x7f\u0085\tb\r\nc")), "a[31mred\tb\r\nc");
	});

	it("keeps content otherwise raw: markup, closing tags and wide characters", () => {
		const raw = "</context-ref> <b>&amp;</b> \u00e9\u4e16\u{1f600}";
		assert.equal(sanitizeText(new TextEncoder().encode(raw)), raw);
	});
});

describe("contextBlock", () => {
	it("writes the attributes in order, then the body between a newline after the opening tag and one before the closing tag", () => {
		assert.equal(
			contextBlock({ name: "api", kind: "file", path: "src/api.ts", body: "line1\nline2\n" }),
			'<context-ref name="api" kind="file" path="src/api.ts" bytes="12">\nline1\nline2\n\n</context-ref>',
		);
	});

	it("counts bytes in UTF-8, not characters", () => {
		assert.match(contextBlock({ name: "a", kind: "file", path: "a", body: "\u00e9\u4e16\u{1f600}" }), /bytes="9"/);
	});

	it("gives an empty body bytes 0 and the same framing", () => {
		assert.equal(contextBlock({ name: "a", kind: "file", path: "a", body: "" }), '<context-ref name="a" kind="file" path="a" bytes="0">\n\n</context-ref>');
	});

	it("adds truncated after bytes and escapes its value", () => {
		assert.equal(
			contextBlock({ name: "a", kind: "file", path: "a", body: "x", truncated: "50 KB" }),
			'<context-ref name="a" kind="file" path="a" bytes="1" truncated="50 KB">\nx\n</context-ref>',
		);
		assert.match(contextBlock({ name: "a", kind: "file", path: "a", body: "", truncated: '"<' }), / truncated="&quot;&lt;">/);
	});

	it("does not escape a closing tag in the body", () => {
		const block = contextBlock({ name: "a", kind: "file", path: "a", body: "x</context-ref>y" });
		assert.ok(block.includes("\nx</context-ref>y\n"));
		assert.match(block, /bytes="16"/);
	});

	it("escapes quotes, ampersands and angle brackets in attribute values, and flattens control characters", () => {
		const block = contextBlock({ name: "a", kind: "file", path: 'we"ird&<p>\nname', body: "" });
		assert.ok(block.includes('path="we&quot;ird&amp;&lt;p&gt; name"'), block);
	});
});

describe("a Dynamic block", () => {
	it("names the source after the kind, then bytes, then exit and truncated", () => {
		assert.equal(
			contextBlock({ name: "diff", kind: "dynamic", source: "git diff", body: "$ git diff\nx", exit: 2, truncated: "50 KB" }),
			'<context-ref name="diff" kind="dynamic" source="git diff" bytes="12" exit="2" truncated="50 KB">\n$ git diff\nx\n</context-ref>',
		);
	});

	it("leaves exit and truncated out when they are not given", () => {
		assert.equal(
			contextBlock({ name: "diff", kind: "dynamic", source: "git diff", body: "x" }),
			'<context-ref name="diff" kind="dynamic" source="git diff" bytes="1">\nx\n</context-ref>',
		);
	});

	it("has a Failure note with the source and the reason", () => {
		assert.equal(
			failureNote({ name: "diff", kind: "dynamic", source: "git diff", error: "not a git repository" }),
			'<context-ref name="diff" kind="dynamic" source="git diff" bytes="0" error="not a git repository">\n\n</context-ref>',
		);
	});
});

describe("failureNote", () => {
	it("is an empty block with bytes 0 and the reason in an error attribute after bytes", () => {
		assert.equal(
			failureNote({ name: "api", kind: "file", path: "src/api.ts", error: "src/api.ts does not exist" }),
			'<context-ref name="api" kind="file" path="src/api.ts" bytes="0" error="src/api.ts does not exist">\n\n</context-ref>',
		);
	});
});

describe("namesWithBlock", () => {
	it("finds the name of each block that opens a line, case-folded", () => {
		const text = `prose\n\n${contextBlock({ name: "Api", kind: "file", path: "a", body: "x" })}\n\n${failureNote({ name: "log", kind: "file", path: "l", error: "e" })}`;
		assert.deepEqual([...namesWithBlock(text)].sort(), ["api", "log"]);
	});

	it("reads a name that was escaped as an attribute back to the name it had", () => {
		const text = contextBlock({ name: 'a&b<c>"d".ts', kind: "file", path: 'a&b<c>"d".ts', body: "x" });
		assert.deepEqual([...namesWithBlock(text)], ['a&b<c>"d".ts']);
	});

	it("ignores a block tag in the middle of a line", () => {
		assert.deepEqual([...namesWithBlock('see <context-ref name="api" kind="file"> in the docs')], []);
	});

	it("is empty for text with no block", () => {
		assert.equal(namesWithBlock("plain").size, 0);
	});
});
