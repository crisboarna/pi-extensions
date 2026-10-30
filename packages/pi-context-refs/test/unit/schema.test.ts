import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parseLibrary } from "../../src/core/library.ts";

const schema = JSON.parse(readFileSync(new URL("../../schema/pi-context-refs.schema.json", import.meta.url), "utf8")) as object;
// strictTuples is off for command: the first item is the program (non-empty) and any number of arguments follow.
const ajv = new Ajv2020.default({ strict: true, strictRequired: false, strictTuples: false, allErrors: true });
const schemaAccepts = ajv.compile(schema);

const inFile = (...refs: unknown[]) => ({ version: 1, $schema: "https://example.com/s.json", refs });
const loaderKeepsEveryRef = (file: unknown, count: number) => {
	const result = parseLibrary(JSON.stringify(file), "f.json");
	return result.ok && result.refs.length === count && result.warnings.length === 0;
};

const valid: Record<string, unknown> = {
	"a Path": { name: "agents", kind: "path", path: "AGENTS.md" },
	"a File with a limit": { name: "api", kind: "file", path: "src/api.ts", max_bytes: 1048576 },
	"a Snippet": { name: "terse", kind: "snippet", text: "Be brief." },
	"a Dynamic command with every optional field": {
		name: "tests",
		kind: "dynamic",
		command: ["npm", "test"],
		cwd: "pkg",
		timeout: 120,
		max_output: 1048576,
		description: "d",
		tags: ["ci", "Node_20"],
	},
	"a Dynamic url": { name: "spec", kind: "dynamic", url: "https://example.com/spec.md" },
	"a name with dots and dashes": { name: "v1.2-rc_3", kind: "snippet", text: "x" },
	"a scope with a path": { name: "a", kind: "path", path: "x", scope: { path: "~/work" } },
	"a scope with a remote": { name: "a", kind: "path", path: "x", scope: { remote: "github.com/acme/app" } },
	"a scope with both": { name: "a", kind: "path", path: "x", scope: { path: "/srv", remote: "github.com/acme/app" } },
	"a command argument that is empty": { name: "a", kind: "dynamic", command: ["echo", ""] },
};

const invalid: Record<string, unknown> = {
	"no name": { kind: "snippet", text: "x" },
	"a name with a space": { name: "a b", kind: "snippet", text: "x" },
	"a name ending in a dot": { name: "a.", kind: "snippet", text: "x" },
	"an empty name": { name: "", kind: "snippet", text: "x" },
	"an unknown kind": { name: "a", kind: "wat" },
	"an unknown field": { name: "a", kind: "snippet", text: "x", colour: "red" },
	"a Path with no path": { name: "a", kind: "path" },
	"a Snippet with no text": { name: "a", kind: "snippet" },
	"a Snippet with a path": { name: "a", kind: "snippet", text: "x", path: "p" },
	"a Path with text": { name: "a", kind: "path", path: "p", text: "x" },
	"a File with a timeout": { name: "a", kind: "file", path: "p", timeout: 5 },
	"a Path with max_bytes": { name: "a", kind: "path", path: "p", max_bytes: 5 },
	"a Dynamic with neither command nor url": { name: "a", kind: "dynamic" },
	"a Dynamic with both": { name: "a", kind: "dynamic", command: ["x"], url: "http://x" },
	"an empty command": { name: "a", kind: "dynamic", command: [] },
	"a command with no program": { name: "a", kind: "dynamic", command: [""] },
	"a command given as a string": { name: "a", kind: "dynamic", command: "git diff" },
	"a url that is not http": { name: "a", kind: "dynamic", url: "file:///etc/passwd" },
	"a cwd on a url": { name: "a", kind: "dynamic", url: "http://x", cwd: "." },
	"a Dynamic with a path": { name: "a", kind: "dynamic", url: "http://x", path: "p" },
	"max_bytes above 1 MB": { name: "a", kind: "file", path: "p", max_bytes: 1048577 },
	"a timeout above 120": { name: "a", kind: "dynamic", url: "http://x", timeout: 121 },
	"a timeout of 0": { name: "a", kind: "dynamic", url: "http://x", timeout: 0 },
	"a timeout that is not whole": { name: "a", kind: "dynamic", url: "http://x", timeout: 1.5 },
	"max_output above 1 MB": { name: "a", kind: "dynamic", url: "http://x", max_output: 1048577 },
	"a description that is not text": { name: "a", kind: "snippet", text: "x", description: 1 },
	"tags that are not a list": { name: "a", kind: "snippet", text: "x", tags: "a" },
	"a tag with a space": { name: "a", kind: "snippet", text: "x", tags: ["no way"] },
	"an empty scope": { name: "a", kind: "snippet", text: "x", scope: {} },
	"a scope with an unknown key": { name: "a", kind: "snippet", text: "x", scope: { dir: "x" } },
	"a scope remote that is empty": { name: "a", kind: "snippet", text: "x", scope: { remote: "" } },
};

describe("schema/pi-context-refs.schema.json, Ref by Ref", () => {
	for (const [label, ref] of Object.entries(valid)) {
		it(`accepts ${label}, as the loader does`, () => {
			assert.equal(schemaAccepts(inFile(ref)), true, JSON.stringify(schemaAccepts.errors));
			assert.equal(loaderKeepsEveryRef(inFile(ref), 1), true);
		});
	}

	for (const [label, ref] of Object.entries(invalid)) {
		it(`rejects ${label}, and the loader skips the Ref`, () => {
			assert.equal(schemaAccepts(inFile(ref)), false);
			assert.equal(loaderKeepsEveryRef(inFile(ref), 1), false);
		});
	}
});

describe("schema/pi-context-refs.schema.json, the file", () => {
	it("accepts a file with version 1, $schema and no Refs", () => {
		assert.equal(schemaAccepts({ version: 1, $schema: "x" }), true);
		assert.equal(schemaAccepts(inFile()), true);
	});

	it("accepts settings and other top-level keys it does not describe", () => {
		assert.equal(schemaAccepts({ version: 1, trigger: "#", builtins: false, refs: [] }), true);
	});

	it("describes the trigger and builtins settings", () => {
		assert.equal(schemaAccepts({ version: 1, trigger: "$", builtins: ["log", "diff"] }), true);
		for (const settings of [{ trigger: 5 }, { trigger: "" }, { builtins: "yes" }, { builtins: ["nope"] }, { builtins: ["log", "log"] }])
			assert.equal(schemaAccepts({ version: 1, ...settings }), false, JSON.stringify(settings));
	});

	it("rejects a missing or different version", () => {
		for (const file of [{ refs: [] }, { version: 2 }, { version: "1" }]) assert.equal(schemaAccepts(file), false, JSON.stringify(file));
	});

	it("rejects refs that is not a list, or a top level that is not an object", () => {
		assert.equal(schemaAccepts({ version: 1, refs: {} }), false);
		assert.equal(schemaAccepts([]), false);
	});

	it("leaves a case-only duplicate name to the loader, which skips the later Ref", () => {
		const file = inFile({ name: "Api", kind: "snippet", text: "a" }, { name: "api", kind: "snippet", text: "b" });
		assert.equal(schemaAccepts(file), true);
		assert.equal(loaderKeepsEveryRef(file, 1), false);
		const loaded = parseLibrary(JSON.stringify(file), "f.json");
		assert.equal(loaded.ok && loaded.refs.length, 1);
	});
});
