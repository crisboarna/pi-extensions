// A package is published from its `files` list. A module that the entry point loads only on a rare path can be left out of that list and
// pass every test that runs from the repository, then fail for a user as "cannot find module". Following the imports finds it before publishing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { missingFromPack, reachableFiles, specifiers } from "../scripts/lib/reachable.ts";

const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "reachable-"));
	made.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

describe("specifiers", () => {
	test("finds static and dynamic imports, exports and bare imports, and ignores comments", () => {
		const text = [
			'import { a } from "./a.ts";',
			'export * from "./b.ts";',
			'const lazy = await import("./c.ts");',
			'import "./d.ts";',
			'// import { x } from "./commented.ts";',
			'/* import { y } from "./blocked.ts"; */',
			'import { join } from "node:path";',
		].join("\n");
		assert.deepEqual(specifiers(text).sort(), ["./a.ts", "./b.ts", "./c.ts", "./d.ts", "node:path"]);
	});
});

describe("reachableFiles", () => {
	test("follows relative imports from the entry point, through folders, and no further", () => {
		const root = tree({
			"src/index.ts": 'import { a } from "./pi/a.ts";\nimport "node:fs";',
			"src/pi/a.ts": 'import { b } from "../core/b.ts";',
			"src/core/b.ts": "export const b = 1;",
			"src/unused.ts": "export const unused = 1;",
			"test/a.test.ts": 'import "../src/unused.ts";',
		});
		assert.deepEqual(reachableFiles(root, ["./src/index.ts"]), ["src/core/b.ts", "src/index.ts", "src/pi/a.ts"]);
	});

	test("reaches a module that is only imported lazily, inside a function", () => {
		const root = tree({
			"src/index.ts": 'export async function rare() {\n\treturn (await import("./rare.ts")).value;\n}',
			"src/rare.ts": "export const value = 1;",
		});
		assert.deepEqual(reachableFiles(root, ["src/index.ts"]), ["src/index.ts", "src/rare.ts"]);
	});

	test("follows a cycle once, and several entry points together", () => {
		const root = tree({
			"src/a.ts": 'import "./b.ts";',
			"src/b.ts": 'import "./a.ts";',
			"bin/cli.js": 'import "../src/a.ts";',
			"src/other.ts": "export {};",
		});
		assert.deepEqual(reachableFiles(root, ["src/a.ts", "bin/cli.js", "src/other.ts"]), ["bin/cli.js", "src/a.ts", "src/b.ts", "src/other.ts"]);
	});

	test("reaches a JSON file an entry imports without reading it as code, and leaves out a file that does not exist", () => {
		const root = tree({
			"src/index.ts": 'import data from "../data/servers.json" with { type: "json" };\nimport "./gone.ts";',
			"data/servers.json": '{ "import": "./not-followed.ts" }',
		});
		assert.deepEqual(reachableFiles(root, ["src/index.ts"]), ["data/servers.json", "src/index.ts"]);
	});

	test("an entry point that does not exist reaches nothing", () => {
		assert.deepEqual(reachableFiles(tree({}), ["src/index.ts"]), []);
	});
});

describe("missingFromPack", () => {
	test("names every reachable file the tarball does not hold, and none it does", () => {
		assert.deepEqual(missingFromPack(["src/a.ts", "src/lazy.ts", "data/x.json"], ["src/a.ts", "README.md"]), ["src/lazy.ts", "data/x.json"]);
		assert.deepEqual(missingFromPack(["src/a.ts"], ["src/a.ts"]), []);
	});
});
