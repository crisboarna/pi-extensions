import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLibrary } from "../../src/core/library.ts";

const FILE = "pi-context-refs.json";
const file = (refs: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, $schema: "x", refs, ...extra });

function loaded(text: string) {
	const result = parseLibrary(text, FILE);
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.ok ? result : assert.fail("not loaded");
}

describe("parseLibrary: the file", () => {
	it("reads a file with version 1 and a list of Refs", () => {
		const library = loaded(file([{ name: "terse", kind: "snippet", text: "Be brief." }]));
		assert.deepEqual(library.refs, [{ name: "terse", kind: "snippet", text: "Be brief." }]);
		assert.deepEqual(library.warnings, []);
	});

	it("reads a file with no Refs, or without the refs list, as an empty library", () => {
		assert.deepEqual(loaded(file([])).refs, []);
		assert.deepEqual(loaded(JSON.stringify({ version: 1 })).refs, []);
	});

	it("keeps unknown top-level keys out of the way", () => {
		assert.deepEqual(loaded(file([], { trigger: "#", builtins: false })).refs, []);
	});

	it("refuses text that is not JSON, naming the file", () => {
		const result = parseLibrary("{ nope", FILE);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /^pi-context-refs\.json does not parse: /);
	});

	it("refuses a top level that is not an object", () => {
		for (const text of ["[]", "3", "null", '"x"']) {
			const result = parseLibrary(text, FILE);
			assert.equal(result.ok, false, text);
			assert.match(result.ok ? "" : result.error, /must be a JSON object/);
		}
	});

	it("refuses a version other than 1, or none", () => {
		for (const text of [JSON.stringify({ version: 2, refs: [] }), JSON.stringify({ refs: [] }), JSON.stringify({ version: "1", refs: [] })]) {
			const result = parseLibrary(text, FILE);
			assert.equal(result.ok, false, text);
			assert.match(result.ok ? "" : result.error, /\$\.version must be 1/);
		}
	});

	it("refuses a refs value that is not a list", () => {
		const result = parseLibrary(JSON.stringify({ version: 1, refs: {} }), FILE);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /\$\.refs must be a list/);
	});
});

describe("parseLibrary: a valid Ref of every kind", () => {
	it("reads Path and File targets with their limits", () => {
		const refs = [
			{ name: "agents", kind: "path", path: "AGENTS.md", description: "Rules", tags: ["docs", "Rules_1"] },
			{ name: "api", kind: "file", path: "~/src/api.ts", max_bytes: 100000 },
		];
		assert.deepEqual(loaded(file(refs)).refs, refs);
	});

	it("reads a Dynamic Ref with a command, cwd and limits", () => {
		const ref = { name: "tests", kind: "dynamic", command: ["npm", "test"], cwd: "packages/a", timeout: 120, max_output: 1048576 };
		assert.deepEqual(loaded(file([ref])).refs, [ref]);
	});

	it("reads a Dynamic Ref with a url", () => {
		const ref = { name: "spec", kind: "dynamic", url: "https://example.com/spec.md" };
		assert.deepEqual(loaded(file([ref])).refs, [ref]);
	});

	it("reads a scope with a path, a remote or both", () => {
		const refs = [
			{ name: "a", kind: "path", path: "x", scope: { path: "~/work" } },
			{ name: "b", kind: "path", path: "x", scope: { remote: "github.com/acme/app" } },
			{ name: "c", kind: "path", path: "x", scope: { path: "/srv/*", remote: "github.com/acme/app" } },
		];
		assert.deepEqual(loaded(file(refs)).refs, refs);
	});
});

describe("parseLibrary: an invalid Ref is skipped with one warning naming the file and the JSON path", () => {
	const skipped = (ref: unknown, ...others: unknown[]) => loaded(file([ref, ...others]));

	it("keeps the Refs around it", () => {
		const good = { name: "ok", kind: "snippet", text: "x" };
		const library = skipped({ name: "bad", kind: "wat" }, good);
		assert.deepEqual(library.refs, [good]);
		assert.equal(library.warnings.length, 1);
		assert.match(library.warnings[0] ?? "", /^pi-context-refs\.json \$\.refs\[0\]\.kind: /);
	});

	const cases: Array<[string, unknown, RegExp]> = [
		["a Ref that is not an object", 3, /^pi-context-refs\.json \$\.refs\[0\]: must be an object/],
		["a name that is missing", { kind: "snippet", text: "x" }, /\$\.refs\[0\]\.name: /],
		["a name that is not text", { name: 4, kind: "snippet", text: "x" }, /\$\.refs\[0\]\.name: /],
		["a name with a space", { name: "a b", kind: "snippet", text: "x" }, /\$\.refs\[0\]\.name: .*letters, digits/],
		["a name ending in a dot", { name: "a.", kind: "snippet", text: "x" }, /\$\.refs\[0\]\.name: .*end in/],
		["a kind that is missing", { name: "a" }, /\$\.refs\[0\]\.kind: must be one of path, file, snippet, dynamic/],
		["a Path with no path", { name: "a", kind: "path" }, /\$\.refs\[0\]\.path: is required for a path Ref/],
		["a File with an empty path", { name: "a", kind: "file", path: "" }, /\$\.refs\[0\]\.path: /],
		["a Snippet with no text", { name: "a", kind: "snippet" }, /\$\.refs\[0\]\.text: is required for a snippet Ref/],
		["a Snippet with a path", { name: "a", kind: "snippet", text: "x", path: "p" }, /\$\.refs\[0\]\.path: is not used by a snippet Ref/],
		["a Path with text", { name: "a", kind: "path", path: "p", text: "x" }, /\$\.refs\[0\]\.text: is not used by a path Ref/],
		["a Dynamic with neither command nor url", { name: "a", kind: "dynamic" }, /\$\.refs\[0\]: a dynamic Ref needs exactly one of command and url/],
		["a Dynamic with both", { name: "a", kind: "dynamic", command: ["x"], url: "http://x" }, /\$\.refs\[0\]: a dynamic Ref needs exactly one/],
		["an empty command", { name: "a", kind: "dynamic", command: [] }, /\$\.refs\[0\]\.command: must be a non-empty list of text/],
		["a command with a non-text item", { name: "a", kind: "dynamic", command: ["x", 2] }, /\$\.refs\[0\]\.command: /],
		["a command with an empty program", { name: "a", kind: "dynamic", command: [""] }, /\$\.refs\[0\]\.command: /],
		["a command given as a string", { name: "a", kind: "dynamic", command: "git diff" }, /\$\.refs\[0\]\.command: /],
		["a url that is not http or https", { name: "a", kind: "dynamic", url: "file:///etc/passwd" }, /\$\.refs\[0\]\.url: must be an http or https URL/],
		["a url that does not parse", { name: "a", kind: "dynamic", url: "nope" }, /\$\.refs\[0\]\.url: /],
		["a cwd on a url Ref", { name: "a", kind: "dynamic", url: "http://x", cwd: "." }, /\$\.refs\[0\]\.cwd: is only used with a command/],
		["a cwd on a File", { name: "a", kind: "file", path: "p", cwd: "." }, /\$\.refs\[0\]\.cwd: /],
		["max_bytes on a Path", { name: "a", kind: "path", path: "p", max_bytes: 5 }, /\$\.refs\[0\]\.max_bytes: is not used by a path Ref/],
		[
			"max_bytes above 1 MB",
			{ name: "a", kind: "file", path: "p", max_bytes: 1048577 },
			/\$\.refs\[0\]\.max_bytes: must be a whole number from 1 to 1048576/,
		],
		["max_bytes of 0", { name: "a", kind: "file", path: "p", max_bytes: 0 }, /\$\.refs\[0\]\.max_bytes: /],
		["max_bytes that is not whole", { name: "a", kind: "file", path: "p", max_bytes: 1.5 }, /\$\.refs\[0\]\.max_bytes: /],
		["timeout on a File", { name: "a", kind: "file", path: "p", timeout: 5 }, /\$\.refs\[0\]\.timeout: is not used by a file Ref/],
		["timeout above 120", { name: "a", kind: "dynamic", url: "http://x", timeout: 121 }, /\$\.refs\[0\]\.timeout: must be a whole number from 1 to 120/],
		[
			"max_output above 1 MB",
			{ name: "a", kind: "dynamic", url: "http://x", max_output: 2000000 },
			/\$\.refs\[0\]\.max_output: must be a whole number from 1 to 1048576/,
		],
		["a description that is not text", { name: "a", kind: "snippet", text: "x", description: 1 }, /\$\.refs\[0\]\.description: must be text/],
		["tags that are not a list", { name: "a", kind: "snippet", text: "x", tags: "a" }, /\$\.refs\[0\]\.tags: must be a list of names/],
		["a tag with a space", { name: "a", kind: "snippet", text: "x", tags: ["ok", "no way"] }, /\$\.refs\[0\]\.tags\[1\]: /],
		["a scope that is not an object", { name: "a", kind: "snippet", text: "x", scope: "here" }, /\$\.refs\[0\]\.scope: must be an object/],
		["an empty scope", { name: "a", kind: "snippet", text: "x", scope: {} }, /\$\.refs\[0\]\.scope: needs a path, a remote or both/],
		["a scope with an unknown key", { name: "a", kind: "snippet", text: "x", scope: { dir: "x" } }, /\$\.refs\[0\]\.scope\.dir: is not a known field/],
		["a scope path that is not text", { name: "a", kind: "snippet", text: "x", scope: { path: 3 } }, /\$\.refs\[0\]\.scope\.path: /],
		["a scope remote that is empty", { name: "a", kind: "snippet", text: "x", scope: { remote: "" } }, /\$\.refs\[0\]\.scope\.remote: /],
		["an unknown field", { name: "a", kind: "snippet", text: "x", colour: "red" }, /\$\.refs\[0\]\.colour: is not a known field/],
	];
	for (const [label, ref, pattern] of cases) {
		it(`for ${label}`, () => {
			const library = skipped(ref);
			assert.deepEqual(library.refs, []);
			assert.equal(library.warnings.length, 1, JSON.stringify(library.warnings));
			assert.match(library.warnings[0] ?? "", pattern);
		});
	}

	it("reports every problem of the Ref in its single warning", () => {
		const library = skipped({ name: "a b", kind: "path" });
		assert.equal(library.warnings.length, 1);
		assert.match(library.warnings[0] ?? "", /\$\.refs\[0\]\.name: .*\$\.refs\[0\]\.path: /s);
	});

	it("does not echo control characters from the file into a warning", () => {
		const library = skipped({ name: "a\u001b[31mb", kind: "snippet", text: "x" });
		assert.equal(library.warnings.length, 1);
		assert.equal(library.warnings[0]?.includes("\u001b"), false);
	});
});

describe("parseLibrary: duplicate names", () => {
	const snippet = (name: string, text = "x") => ({ name, kind: "snippet", text });

	it("skips a later Ref whose name differs only by case, and keeps the first", () => {
		const library = loaded(file([snippet("Api", "first"), snippet("api", "second")]));
		assert.deepEqual(library.refs, [snippet("Api", "first")]);
		assert.equal(library.warnings.length, 1);
		assert.match(library.warnings[0] ?? "", /^pi-context-refs\.json \$\.refs\[1\]\.name: .*"Api".*\$\.refs\[0\]/);
	});

	it("skips an exact duplicate the same way", () => {
		const library = loaded(file([snippet("a"), snippet("a")]));
		assert.equal(library.refs.length, 1);
		assert.equal(library.warnings.length, 1);
	});

	it("does not count a skipped invalid Ref as holding its name", () => {
		const library = loaded(file([{ name: "a", kind: "wat" }, snippet("a")]));
		assert.equal(library.refs.length, 1);
		assert.equal(library.warnings.length, 1);
	});
});
