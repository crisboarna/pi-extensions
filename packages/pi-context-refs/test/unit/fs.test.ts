import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isFilePresent, linkTargetIfSymlink, readFileBytes, readTextIfPresent, writeTextAtomically } from "../../src/pi/fs.ts";

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

describe("isFilePresent", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-refs-file-"));
	writeFileSync(join(dir, "a.txt"), "x");
	symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));
	symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));

	it("is true for a file and for a symlink to one", () => {
		assert.equal(isFilePresent(join(dir, "a.txt")), true);
		assert.equal(isFilePresent(join(dir, "link.txt")), true);
	});

	it("is false for a missing path, a dangling symlink and a directory", () => {
		assert.equal(isFilePresent(join(dir, "missing")), false);
		assert.equal(isFilePresent(join(dir, "dangling")), false);
		assert.equal(isFilePresent(dir), false);
	});
});

describe("linkTargetIfSymlink", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-refs-link-"));

	it("is where a symlink points, as written, even when nothing is there", () => {
		symlinkSync("../nowhere/x", join(dir, "dangling"));
		assert.equal(linkTargetIfSymlink(join(dir, "dangling")), "../nowhere/x");
	});

	it("is undefined for a file, a directory and a path that does not exist", () => {
		writeFileSync(join(dir, "file"), "x");
		assert.equal(linkTargetIfSymlink(join(dir, "file")), undefined);
		assert.equal(linkTargetIfSymlink(dir), undefined);
		assert.equal(linkTargetIfSymlink(join(dir, "missing")), undefined);
	});
});

describe("readFileBytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-refs-bytes-"));

	it("reads a whole file that is under the limit", async () => {
		writeFileSync(join(dir, "small"), "héllo");
		assert.equal(Buffer.from(await readFileBytes(join(dir, "small"), 100)).toString("utf8"), "héllo");
	});

	it("reads no more than the limit of a larger file", async () => {
		writeFileSync(join(dir, "big"), "x".repeat(1000));
		assert.equal((await readFileBytes(join(dir, "big"), 11)).length, 11);
	});

	it("rejects with the system's error for a missing file and a directory", async () => {
		await assert.rejects(readFileBytes(join(dir, "missing"), 10), { code: "ENOENT" });
		await assert.rejects(readFileBytes(dir, 10), { code: "EISDIR" });
	});
});
