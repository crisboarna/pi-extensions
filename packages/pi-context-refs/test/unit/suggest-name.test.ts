import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestRefName } from "../../src/core/suggest-name.ts";

const none = () => false;

describe("suggestRefName", () => {
	it("is the file name of the path", () => {
		assert.equal(suggestRefName("src/api.ts", none), "api.ts");
		assert.equal(suggestRefName("/home/me/notes/AGENTS.md", none), "AGENTS.md");
		assert.equal(suggestRefName("README.md", none), "README.md");
	});

	it("turns each character outside letters, digits, . - _ into -", () => {
		assert.equal(suggestRefName("docs/my notes (v2).md", none), "my-notes--v2-.md");
		assert.equal(suggestRefName("a/é.txt", none), "-.txt");
		assert.equal(suggestRefName("a/b+c.ts", none), "b-c.ts");
	});

	it("drops a trailing dot, however many", () => {
		assert.equal(suggestRefName("a/archive.", none), "archive");
		assert.equal(suggestRefName("a/archive...", none), "archive");
	});

	it("keeps a name that starts with a dot", () => {
		assert.equal(suggestRefName("project/.env.example", none), ".env.example");
	});

	it("falls back to ref when nothing is left of the file name", () => {
		assert.equal(suggestRefName("a/...", none), "ref");
		assert.equal(suggestRefName("/", none), "ref");
	});

	it("adds -2, -3 on a clash in the target library, ignoring case", () => {
		const taken = new Set(["api.ts", "api.ts-2", "readme.md"]);
		const clashes = (name: string) => taken.has(name.toLowerCase());
		assert.equal(suggestRefName("src/api.ts", clashes), "api.ts-3");
		assert.equal(suggestRefName("README.md", clashes), "README.md-2");
		assert.equal(suggestRefName("src/other.ts", clashes), "other.ts");
	});

	it("reads a Windows separator as a separator", () => {
		assert.equal(suggestRefName("src\\api.ts", none), "api.ts");
	});
});
