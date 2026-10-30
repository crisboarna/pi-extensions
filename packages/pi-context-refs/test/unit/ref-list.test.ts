import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { describeRef, formatList, readSettings } from "../../src/core/ref-list.ts";

describe("readSettings", () => {
	it("defaults to the # Trigger with Built-in Refs on", () => {
		assert.deepEqual(readSettings(undefined), { trigger: "#", builtins: true });
		assert.deepEqual(readSettings("{ not json"), { trigger: "#", builtins: true });
		assert.deepEqual(readSettings("[]"), { trigger: "#", builtins: true });
	});

	it("reads trigger and builtins", () => {
		assert.deepEqual(readSettings('{"version":1,"trigger":"$","builtins":false}'), { trigger: "$", builtins: false });
		assert.deepEqual(readSettings('{"version":1,"builtins":["log","diff"]}'), { trigger: "#", builtins: ["log", "diff"] });
	});

	it("ignores values of the wrong type", () => {
		assert.deepEqual(readSettings('{"trigger":5,"builtins":"yes"}'), { trigger: "#", builtins: true });
		assert.deepEqual(readSettings('{"trigger":"","builtins":[1,"log"]}'), { trigger: "#", builtins: true });
	});
});

describe("describeRef", () => {
	const line = (ref: Ref) => describeRef(ref);

	it("shows name, kind, tags and a target summary", () => {
		assert.equal(line({ name: "api", kind: "file", path: "src/api.ts", tags: ["a", "b"] }), "api  file  [a, b]  src/api.ts");
		assert.equal(line({ name: "agents", kind: "path", path: "AGENTS.md" }), "agents  path  AGENTS.md");
		assert.equal(line({ name: "log", kind: "dynamic", command: ["git", "log", "--format=%h %s"] }), "log  dynamic  git log --format=%h %s");
		assert.equal(line({ name: "page", kind: "dynamic", url: "https://example.com/x" }), "page  dynamic  https://example.com/x");
	});

	it("shows a Snippet's text on one line and cuts a long one", () => {
		assert.equal(line({ name: "t", kind: "snippet", text: "one\ntwo" }), 't  snippet  "one two"');
		const long = describeRef({ name: "t", kind: "snippet", text: "x".repeat(200) });
		assert.ok(long.length < 100, long);
		assert.match(long, /…"$/);
	});

	it("replaces control characters in what the file says, so a terminal never sees them", () => {
		assert.equal(line({ name: "p", kind: "path", path: "a\u001b[31mb" }), "p  path  a [31mb");
	});

	it("marks a Scoped Ref", () => {
		assert.equal(line({ name: "s", kind: "snippet", text: "x", scope: { path: "src" } }), 's  snippet  scope: path src  "x"');
		assert.equal(
			line({ name: "s", kind: "snippet", text: "x", scope: { path: "src", remote: "github.com/a/b" } }),
			's  snippet  scope: path src, remote github.com/a/b  "x"',
		);
	});
});

const base = {
	file: "/agent/pi-context-refs.json",
	settings: { trigger: "#", builtins: true as boolean | string[] },
	sessionTrigger: "#",
	refs: [] as Ref[],
	warnings: [] as string[],
	filter: {},
};

describe("formatList", () => {
	it("prints the settings, the library and its Refs", () => {
		const text = formatList({ ...base, refs: [{ name: "api", kind: "file", path: "a.ts" }] });
		assert.equal(
			text,
			["pi-context-refs", "trigger: #", "builtins: on", "", "Global library /agent/pi-context-refs.json (1 Ref)", "  api  file  a.ts"].join("\n"),
		);
	});

	it("says when there are no Refs", () => {
		assert.match(formatList(base), /Global library \/agent\/pi-context-refs\.json \(no Refs\)/);
	});

	it("describes builtins when they are off", () => {
		assert.match(formatList({ ...base, settings: { trigger: "#", builtins: false } }), /^builtins: off$/m);
		assert.match(formatList({ ...base, settings: { trigger: "#", builtins: ["log", "diff"] } }), /^builtins: off for log, diff$/m);
	});

	it("notes that a changed trigger needs /reload", () => {
		const text = formatList({ ...base, settings: { trigger: "$", builtins: true } });
		assert.match(text, /^trigger: \$ in the file, # in this session; run \/reload to use it$/m);
	});

	it("filters by tag, case-insensitively, and says when nothing matches", () => {
		const refs: Ref[] = [
			{ name: "a", kind: "path", path: "x", tags: ["Docs"] },
			{ name: "b", kind: "path", path: "y" },
		];
		const text = formatList({ ...base, refs, filter: { tag: "docs" } });
		assert.match(text, /\(1 of 2 Refs, tag docs\)/);
		assert.match(text, /^ {2}a {2}path/m);
		assert.doesNotMatch(text, /^ {2}b /m);
		assert.match(formatList({ ...base, refs, filter: { tag: "none" } }), /\(0 of 2 Refs, tag none\)/);
	});

	it("lists load warnings and an unusable file", () => {
		const text = formatList({ ...base, warnings: ["/agent/pi-context-refs.json $.refs[0].name: bad"] });
		assert.match(text, /\nWarnings:\n {2}\/agent\/pi-context-refs\.json \$\.refs\[0\]\.name: bad$/);
		const unusable = formatList({ ...base, error: "/agent/pi-context-refs.json does not parse: x" });
		assert.match(unusable, /\nWarnings:\n {2}\/agent\/pi-context-refs\.json does not parse: x; no Refs are loaded$/);
	});
});
