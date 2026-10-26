import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { coreViolations, files, importSpecifiers, ROOT } from "../support/source-scan.ts";

const CORE_FILE = join(ROOT, "src", "core", "example.ts");

describe("importSpecifiers", () => {
	it("reads static, re-export, side-effect, dynamic and require forms", () => {
		const source = [
			'import { a } from "./a.ts";',
			'import type { B } from "@earendil-works/pi-ai";',
			'export * from "./c.ts";',
			'import "./d.ts";',
			'const e = await import("./e.ts");',
			'const f = require("node:fs");',
		].join("\n");
		assert.deepEqual(importSpecifiers(source).sort(), ["./a.ts", "./c.ts", "./d.ts", "./e.ts", "@earendil-works/pi-ai", "node:fs"]);
	});
});

describe("core purity check", () => {
	it("flags a pi host package import", () => {
		assert.deepEqual(coreViolations(CORE_FILE, 'import type { X } from "@earendil-works/pi-coding-agent";'), ["@earendil-works/pi-coding-agent"]);
	});

	it("flags a relative import that leaves src/core", () => {
		assert.deepEqual(coreViolations(CORE_FILE, 'import { hook } from "../pi/hooks.ts";'), ["../pi/hooks.ts"]);
	});

	it("allows node built-ins and imports inside src/core", () => {
		assert.deepEqual(coreViolations(CORE_FILE, 'import { join } from "node:path";\nimport { y } from "./place.ts";'), []);
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
