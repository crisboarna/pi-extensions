import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findRefTokens } from "../../src/core/tokens.ts";

/** The `form:target` of each token found, so a case reads as a table. */
const found = (text: string): string[] => findRefTokens(text).map((token) => `${token.form}:${token.target}`);

describe("typed #name tokens", () => {
	it("finds a #name at the start, in the middle and at the end of the text", () => {
		assert.deepEqual(found("#terse"), ["typed:terse"]);
		assert.deepEqual(found("please be #terse now"), ["typed:terse"]);
		assert.deepEqual(found("please be #terse"), ["typed:terse"]);
	});

	it("finds several in order", () => {
		assert.deepEqual(found("#a and #b\n#c"), ["typed:a", "typed:b", "typed:c"]);
	});

	it("ends a token at any character that is not a name character", () => {
		assert.deepEqual(found('#terse, #api; #docs! (#x) #y? #z: #w"s" #v\''), [
			"typed:terse",
			"typed:api",
			"typed:docs",
			"typed:x",
			"typed:y",
			"typed:z",
			"typed:w",
			"typed:v",
		]);
	});

	it("keeps dots, dashes and underscores inside a name", () => {
		assert.deepEqual(found("#readme.md and #my-ref_2"), ["typed:readme.md", "typed:my-ref_2"]);
	});

	it("drops trailing dots, so a sentence can end on a ref", () => {
		assert.deepEqual(found("read #readme.md."), ["typed:readme.md"]);
		assert.deepEqual(found("see #notes... ok"), ["typed:notes"]);
	});

	it("gives the span of the token without the dropped dots", () => {
		const text = "read #readme.md. now";
		const [token] = findRefTokens(text);
		assert.equal(token && text.slice(token.start, token.end), "#readme.md");
	});

	it("finds nothing for a bare #, a heading, or a # followed only by punctuation", () => {
		assert.deepEqual(found("#"), []);
		assert.deepEqual(found("# heading\n## second"), []);
		assert.deepEqual(found("a # b #. #, ##"), []);
	});

	it("finds a number-only name too, leaving the matching to the library", () => {
		assert.deepEqual(found("#1 priority, issue #42"), ["typed:1", "typed:42"]);
	});

	it("does not start a token inside a word, a URL or a path", () => {
		assert.deepEqual(found("page#api http://x.com/a#b src/#c a=#d &#e C#sharp é#f x_#g"), []);
	});

	it("starts a token after whitespace, opening punctuation or quotes", () => {
		assert.deepEqual(found("\t#a (#b [#c {#d \"#e 'see #f `#g ,#h"), [
			"typed:a",
			"typed:b",
			"typed:c",
			"typed:d",
			"typed:e",
			"typed:f",
			"typed:g",
			"typed:h",
		]);
	});
});

describe("[ref:...] placeholders", () => {
	it("finds a placeholder and gives its name", () => {
		assert.deepEqual(found("use [ref:api] now"), ["placeholder:api"]);
	});

	it("is bounded only by the closing bracket, so a path form stays whole", () => {
		assert.deepEqual(found("[ref:src/api.ts] [ref:file:src/a b.ts] [ref:./README.md]"), [
			"placeholder:src/api.ts",
			"placeholder:file:src/a b.ts",
			"placeholder:./README.md",
		]);
	});

	it("takes the span of the whole bracket", () => {
		const text = "go [ref:api]!";
		const [token] = findRefTokens(text);
		assert.equal(token && text.slice(token.start, token.end), "[ref:api]");
	});

	it("is found inside a word, because the brackets bound it", () => {
		assert.deepEqual(found("x[ref:api]y"), ["placeholder:api"]);
	});

	it("is not a placeholder when empty, unclosed or broken across lines", () => {
		assert.deepEqual(found("[ref:] [ref:abc [ref:a\nb] [REF:api]"), []);
	});

	it("does not read a # inside a placeholder as a typed token", () => {
		assert.deepEqual(found("[ref:#api]"), ["placeholder:#api"]);
	});

	it("finds typed tokens and placeholders in one pass, in order", () => {
		assert.deepEqual(found("#a [ref:b] #c"), ["typed:a", "placeholder:b", "typed:c"]);
	});
});
