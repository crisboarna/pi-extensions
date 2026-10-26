import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { files, findIds, realIds, ROOT } from "../support/source-scan.ts";

describe("source scan", () => {
	it("detects a real provider id", () => {
		assert.deepEqual(findIds('const provider = "Anthropic";', realIds()), ["anthropic"]);
	});

	it("detects a real model id", () => {
		assert.deepEqual(findIds("pick claude-opus-4-8 here", realIds()), ["claude-opus-4-8"]);
	});

	it("does not flag an id that is only part of a longer word", () => {
		assert.deepEqual(findIds("const googleish = anthropically;", realIds()), []);
	});

	it("keeps every real provider and model id out of src/", () => {
		const offenders: string[] = [];
		for (const file of files(join(ROOT, "src"), ".ts")) {
			for (const id of findIds(readFileSync(file, "utf8"), realIds())) offenders.push(`${file.slice(ROOT.length + 1)}: ${id}`);
		}
		assert.deepEqual(offenders, []);
	});
});
