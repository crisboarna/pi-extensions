import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldName, nameProblem } from "../../src/core/names.ts";

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

describe("foldName", () => {
	it("folds case so names compare case-insensitively", () => {
		assert.equal(foldName("ReadMe.MD"), "readme.md");
	});
});
