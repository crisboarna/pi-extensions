import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFields, buildRef, jsonOf } from "../../src/core/ref-edit.ts";

const add = (refName: string, kind: string, target: string[], fields: Array<[string, string]> = []) =>
	buildRef({ refName, kind, target, fields: fields.map(([key, value]) => ({ key, value })) });

describe("buildRef", () => {
	it("builds a Path, a File and a Snippet from the target words", () => {
		assert.deepEqual(add("p", "path", ["docs", "my", "notes"]), { ok: true, ref: { name: "p", kind: "path", path: "docs my notes" } });
		assert.deepEqual(add("f", "file", ["src/a.ts"]), { ok: true, ref: { name: "f", kind: "file", path: "src/a.ts" } });
		assert.deepEqual(add("s", "snippet", ["Be", "brief."]), { ok: true, ref: { name: "s", kind: "snippet", text: "Be brief." } });
	});

	it("builds a Dynamic Ref with a url from one http or https word, and a command from anything else", () => {
		assert.deepEqual(add("u", "dynamic", ["https://example.com/a?b=c"]), {
			ok: true,
			ref: { name: "u", kind: "dynamic", url: "https://example.com/a?b=c" },
		});
		assert.deepEqual(add("c", "dynamic", ["git", "diff", "--staged"]), {
			ok: true,
			ref: { name: "c", kind: "dynamic", command: ["git", "diff", "--staged"] },
		});
		assert.deepEqual(add("one", "dynamic", ["ls"]), { ok: true, ref: { name: "one", kind: "dynamic", command: ["ls"] } });
	});

	it("keeps shell metacharacters in an argv word as plain text", () => {
		assert.deepEqual(add("m", "dynamic", ["echo", "$(whoami);", "|", "cat"]), {
			ok: true,
			ref: { name: "m", kind: "dynamic", command: ["echo", "$(whoami);", "|", "cat"] },
		});
	});

	it("sets the optional fields: description, tags, limits and scope", () => {
		const result = add(
			"api",
			"file",
			["a.ts"],
			[
				["description", "The API"],
				["tags", " a, B ,,c"],
				["max_bytes", "2048"],
			],
		);
		assert.deepEqual(result, {
			ok: true,
			ref: { name: "api", kind: "file", path: "a.ts", description: "The API", tags: ["a", "B", "c"], max_bytes: 2048 },
		});
		const scoped = add(
			"s",
			"snippet",
			["x"],
			[
				["scope.path", "src"],
				["scope.remote", "github.com/a/b"],
			],
		);
		assert.deepEqual(scoped, { ok: true, ref: { name: "s", kind: "snippet", text: "x", scope: { path: "src", remote: "github.com/a/b" } } });
	});

	it("reports a bad name, a bad kind, a missing target and a field the kind does not use, each with the JSON path of the Ref", () => {
		for (const [result, pattern] of [
			[add("bad name", "snippet", ["x"]), /ref\.name: /],
			[add("x", "folder", ["x"]), /ref\.kind: must be one of path, file, snippet, dynamic/],
			[add("x", "file", []), /ref\.path: is required/],
			[add("x", "snippet", ["x"], [["max_bytes", "10"]]), /ref\.max_bytes: is not used by a snippet Ref/],
			[add("x", "dynamic", []), /exactly one of command and url/],
			[add("x", "file", ["a"], [["max_bytes", "9999999"]]), /ref\.max_bytes: must be a whole number from 1 to 1048576/],
		] as const) {
			assert.equal(result.ok, false);
			assert.match(result.ok ? "" : result.error, pattern);
		}
	});

	it("rejects a limit or a number that is not whole digits", () => {
		const result = add("x", "dynamic", ["ls"], [["timeout", "ten"]]);
		assert.deepEqual(result, { ok: false, error: "timeout must be a whole number" });
	});
});

describe("applyFields", () => {
	const edit = (ref: Record<string, unknown>, fields: Array<[string, string]>) =>
		applyFields(
			ref,
			fields.map(([key, value]) => ({ key, value })),
		);

	it("changes the fields given and keeps the rest", () => {
		assert.deepEqual(
			edit({ name: "api", kind: "file", path: "a.ts", description: "old" }, [
				["path", "b.ts"],
				["tags", "p,q"],
			]),
			{
				ok: true,
				ref: { name: "api", kind: "file", path: "b.ts", description: "old", tags: ["p", "q"] },
			},
		);
	});

	it("removes an optional field when the value is empty", () => {
		assert.deepEqual(
			edit({ name: "api", kind: "file", path: "a.ts", description: "old", tags: ["x"] }, [
				["description", ""],
				["tags", ""],
			]),
			{
				ok: true,
				ref: { name: "api", kind: "file", path: "a.ts" },
			},
		);
	});

	it("renames in place", () => {
		assert.deepEqual(edit({ name: "api", kind: "path", path: "a" }, [["name", "api2"]]), { ok: true, ref: { name: "api2", kind: "path", path: "a" } });
	});

	it("switches a Dynamic Ref between command and url", () => {
		assert.deepEqual(edit({ name: "d", kind: "dynamic", command: ["ls"] }, [["url", "http://localhost:1/x"]]), {
			ok: true,
			ref: { name: "d", kind: "dynamic", url: "http://localhost:1/x" },
		});
		assert.deepEqual(edit({ name: "d", kind: "dynamic", url: "http://localhost:1/x" }, [["command", `git log "--format=%h %s"`]]), {
			ok: true,
			ref: { name: "d", kind: "dynamic", command: ["git", "log", "--format=%h %s"] },
		});
	});

	it("sets and clears scope keys, dropping an empty scope", () => {
		const scoped = { name: "s", kind: "snippet", text: "x", scope: { path: "src", remote: "github.com/a/b" } };
		assert.deepEqual(edit(scoped, [["scope.remote", ""]]), { ok: true, ref: { name: "s", kind: "snippet", text: "x", scope: { path: "src" } } });
		assert.deepEqual(edit({ ...scoped, scope: { path: "src" } }, [["scope.path", ""]]), { ok: true, ref: { name: "s", kind: "snippet", text: "x" } });
	});

	it("validates the result: an empty required field, a field the kind does not use and a bad quote in a command", () => {
		for (const [fields, pattern] of [
			[[["path", ""]], /ref\.path: is required/],
			[[["text", "x"]], /ref\.text: is not used by a file Ref/],
			[[["name", "bad name"]], /ref\.name: /],
		] as const) {
			const result = edit(
				{ name: "api", kind: "file", path: "a" },
				fields.map(([key, value]) => [key, value]),
			);
			assert.equal(result.ok, false);
			assert.match(result.ok ? "" : result.error, pattern);
		}
		const quote = edit({ name: "d", kind: "dynamic", command: ["ls"] }, [["command", `echo "oops`]]);
		assert.deepEqual(quote, { ok: false, error: "command: a double quote is not closed" });
	});
});

describe("jsonOf", () => {
	it("pretty-prints a Ref with a 2-space indent", () => {
		assert.equal(jsonOf({ name: "a", kind: "path", path: "x" }), '{\n  "name": "a",\n  "kind": "path",\n  "path": "x"\n}');
	});
});
