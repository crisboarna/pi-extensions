import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, it } from "node:test";
import { files, ROOT } from "../support/source-scan.ts";

// DESIGN.md section 7: every guard handler catches its own errors, because pi swallows hook errors and carries on.
// `input` returns a result for pi, so its handler in hooks.ts catches its own errors instead of using abortOnError.
const OWN_CATCH = ["src/pi/hooks.ts:input"];

describe("guard handlers", () => {
	it("are all wrapped by abortOnError, except the ones that catch their own errors", () => {
		const unwrapped: string[] = [];
		for (const file of files(`${ROOT}/src/pi`, ".ts")) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/\bpi\.on\(\s*"(\w+)",\s*(abortOnError\()?/g)) {
				const id = `${relative(ROOT, file)}:${match[1]}`;
				if (!match[2] && !OWN_CATCH.includes(id)) unwrapped.push(id);
			}
		}
		assert.deepEqual(unwrapped, []);
	});

	it("includes the /guard command handler", () => {
		const source = readFileSync(`${ROOT}/src/pi/commands.ts`, "utf8");
		assert.match(source, /registerCommand\(\s*"guard",\s*\{[^}]*handler: reportOnError\(/s);
	});
});
