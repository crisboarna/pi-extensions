import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LibraryFile } from "../../src/core/config-writer.ts";
import { entryNames } from "../../src/pi/ref-run.ts";

const file = (refs: unknown[]): LibraryFile => ({ path: "/p/lib.json", read: () => JSON.stringify({ version: 1, refs }), write() {} });

describe("entryNames", () => {
	it("lists the names of the entries, in file order", () => {
		assert.deepEqual(entryNames(file([{ name: "b" }, { name: "a.1" }])), ["b", "a.1"]);
	});

	it("leaves out a name a Ref cannot have, so a repository cannot put control characters into the completions or a dialog", () => {
		assert.deepEqual(entryNames(file([{ name: "ok" }, { name: "\u001b]0;pwned\u0007" }, { name: "two words" }, { name: "" }])), ["ok"]);
	});
});
