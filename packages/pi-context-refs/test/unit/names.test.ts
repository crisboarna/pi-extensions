import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldName, nameProblem, tagProblem } from "../../src/core/names.ts";

describe("nameProblem", () => {
	it("accepts letters, digits, dots, dashes and underscores", () => {
		for (const name of ["api", "API2", "readme.md", "my-ref", "my_ref", "v1.2.3", "a", ".hidden", "-x", "_y"])
			assert.equal(nameProblem(name), undefined, name);
	});

	it("rejects an empty name", () => {
		assert.match(nameProblem("") ?? "", /empty/);
	});

	it("rejects a trailing dot, because a typed ref token ends before it", () => {
		assert.match(nameProblem("notes.") ?? "", /end in "\."/);
		assert.match(nameProblem("notes..") ?? "", /end in "\."/);
	});

	it("rejects every character outside the name set", () => {
		for (const name of ["a b", "a/b", "a:b", "a#b", "a]b", "a[b", "é", "a\nb", "a,b", "~"])
			assert.match(nameProblem(name) ?? "", /letters, digits/, JSON.stringify(name));
	});
});

describe("tagProblem", () => {
	it("takes the same characters as a name, in any case", () => {
		for (const tag of ["docs", "Docs", "a.b-c_d", "v1", ".x"]) assert.equal(tagProblem(tag), undefined, tag);
	});

	it("rejects what a name rejects, in words about a tag", () => {
		assert.match(tagProblem("") ?? "", /a tag cannot be empty/);
		assert.match(tagProblem("a:b") ?? "", /a tag uses only letters, digits/);
		assert.match(tagProblem("docs.") ?? "", /a tag cannot end in "\."/);
	});
});

describe("foldName", () => {
	it("folds case so names compare case-insensitively", () => {
		assert.equal(foldName("ReadMe.MD"), "readme.md");
	});
});
