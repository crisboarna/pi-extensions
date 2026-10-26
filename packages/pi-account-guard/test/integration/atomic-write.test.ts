import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeTextAtomically } from "../../src/pi/fs.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "account-guard-write-"));

describe("writeTextAtomically", () => {
	it("creates the file, and the missing directories above it", () => {
		const path = join(tempDir(), "agent", "account-guard.json");
		writeTextAtomically(path, "{}\n");
		assert.equal(readFileSync(path, "utf8"), "{}\n");
	});

	it("replaces the content of an existing file", () => {
		const path = join(tempDir(), "account-guard.json");
		writeFileSync(path, "old");
		writeTextAtomically(path, "new");
		assert.equal(readFileSync(path, "utf8"), "new");
	});

	it("leaves no temporary file behind", () => {
		const dir = tempDir();
		writeTextAtomically(join(dir, "account-guard.json"), "x");
		assert.deepEqual(readdirSync(dir), ["account-guard.json"]);
	});

	it("keeps the old file and leaves no temporary file when the rename fails", () => {
		const dir = tempDir();
		// A directory at the target path makes the rename fail.
		const path = join(dir, "account-guard.json");
		writeTextAtomically(join(path, "inner"), "x");
		assert.throws(() => writeTextAtomically(path, "new"));
		assert.deepEqual(readdirSync(dir), ["account-guard.json"]);
	});
});
