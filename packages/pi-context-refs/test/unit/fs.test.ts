import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTextIfPresent, writeTextAtomically } from "../../src/pi/fs.ts";

describe("readTextIfPresent", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-refs-fs-"));

	it("reads a file", () => {
		writeFileSync(join(dir, "a.json"), "héllo");
		assert.equal(readTextIfPresent(join(dir, "a.json")), "héllo");
	});

	it("is undefined for a file that does not exist", () => {
		assert.equal(readTextIfPresent(join(dir, "missing.json")), undefined);
	});

	it("throws for any other failure, so a file that cannot be read is not taken for a missing one", () => {
		assert.throws(() => readTextIfPresent(dir), { code: "EISDIR" });
	});
});

describe("writeTextAtomically", () => {
	it("creates the directory and the file, and leaves no temporary file", () => {
		const dir = mkdtempSync(join(tmpdir(), "context-refs-write-"));
		const path = join(dir, "nested", "a.json");
		writeTextAtomically(path, "one");
		writeTextAtomically(path, "two");
		assert.equal(readFileSync(path, "utf8"), "two");
		assert.deepEqual(readdirSync(join(dir, "nested")), ["a.json"]);
	});

	it("leaves the old file and no temporary file when the write fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "context-refs-write-"));
		const path = join(dir, "a.json");
		writeFileSync(path, "old");
		mkdirSync(join(dir, "blocked"));
		assert.throws(() => writeTextAtomically(join(dir, "blocked"), "new"), { code: "EISDIR" });
		assert.deepEqual(readdirSync(dir).sort(), ["a.json", "blocked"]);
		assert.equal(readFileSync(path, "utf8"), "old");
	});
});
