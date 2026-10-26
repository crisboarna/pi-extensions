import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { coreViolations, files, importSpecifiers, ROOT } from "../support/source-scan.ts";

const CORE_FILE = join(ROOT, "src", "core", "example.ts");
// The snippets live in test/fixtures so the repository import check does not read them as real imports.
const snippet = (name: string): string => readFileSync(join(ROOT, "test", "fixtures", "imports", `${name}.ts.txt`), "utf8");

describe("importSpecifiers", () => {
	it("reads static, re-export, side-effect, dynamic and require forms", () => {
		assert.deepEqual(importSpecifiers(snippet("all-forms")).sort(), ["./a.ts", "./c.ts", "./d.ts", "./e.ts", "@earendil-works/pi-ai", "node:fs"]);
	});
});

describe("core purity check", () => {
	it("flags a pi host package import", () => {
		assert.deepEqual(coreViolations(CORE_FILE, snippet("pi-host")), ["@earendil-works/pi-coding-agent"]);
	});

	it("flags a relative import that leaves src/core", () => {
		assert.deepEqual(coreViolations(CORE_FILE, snippet("leaves-core")), ["../pi/hooks.ts"]);
	});

	it("allows node built-ins and imports inside src/core", () => {
		assert.deepEqual(coreViolations(CORE_FILE, snippet("inside-core")), []);
	});
});

describe("pure core", () => {
	it("imports nothing from pi", () => {
		const offenders: string[] = [];
		for (const file of files(join(ROOT, "src", "core"), ".ts")) {
			for (const specifier of coreViolations(file, readFileSync(file, "utf8"))) offenders.push(`${file.slice(ROOT.length + 1)}: ${specifier}`);
		}
		assert.deepEqual(offenders, []);
	});
});
