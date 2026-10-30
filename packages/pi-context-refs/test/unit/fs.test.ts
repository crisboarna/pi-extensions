import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTextIfPresent } from "../../src/pi/fs.ts";

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
