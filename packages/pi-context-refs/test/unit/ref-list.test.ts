import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { describeRef, formatList, readSettings } from "../../src/core/ref-list.ts";
import type { Place } from "../../src/core/scope.ts";

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

const here: Place = { cwd: "/work/app", home: "/home/me", realpath: (path) => path, remotes: () => ["https://github.com/acme/app.git"] };

const base = {
	place: here,
	project: { file: "/work/app/.pi/pi-context-refs.json", refs: [] as Ref[], warnings: [] as string[] },
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
			[
				"pi-context-refs",
				"trigger: #",
				"builtins: on",
				"",
				"Project library /work/app/.pi/pi-context-refs.json (no Refs)",
				"",
				"Global library /agent/pi-context-refs.json (1 Ref)",
				"  api  file  a.ts",
			].join("\n"),
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

describe("formatList: Approvals", () => {
	const project = (refs: Ref[]) => ({ file: "/work/app/.pi/pi-context-refs.json", refs, warnings: [] as string[] });
	const tests: Ref = { name: "tests", kind: "dynamic", command: ["npm", "test"] };
	const spec: Ref = { name: "spec", kind: "dynamic", url: "https://example.com/spec" };
	const notes: Ref = { name: "notes", kind: "snippet", text: "x" };

	it("marks each Project Dynamic Ref as approved or pending, and leaves other Refs alone", () => {
		const text = formatList({
			...base,
			project: project([tests, spec, notes]),
			approvalOf: (ref) => (ref.kind !== "dynamic" ? undefined : ref.name === "tests" ? "approved" : "pending"),
		});
		assert.match(text, /^ {2}tests {2}dynamic {2}npm test {2}\(approved\)$/m);
		assert.match(text, /^ {2}spec {2}dynamic {2}https:\/\/example\.com\/spec {2}\(pending\)$/m);
		assert.match(text, /^ {2}notes {2}snippet {2}"x"$/m);
	});

	it("marks nothing in the Global library", () => {
		const text = formatList({ ...base, refs: [tests], approvalOf: () => "approved" });
		assert.match(text, /^ {2}tests {2}dynamic {2}npm test$/m);
	});
});

describe("formatList: layers", () => {
	const snippet = (name: string, text: string, scope?: Ref["scope"]): Ref => ({ name, kind: "snippet", text, ...(scope && { scope }) });
	const project = (refs: Ref[], warnings: string[] = []) => ({ file: "/work/app/.pi/pi-context-refs.json", refs, warnings });
	const sectionOf = (text: string, title: RegExp): string[] => {
		const lines = text.split("\n");
		const start = lines.findIndex((line) => title.test(line));
		assert.notEqual(start, -1, `no section ${title} in\n${text}`);
		const rest = lines.slice(start + 1);
		const end = rest.findIndex((line) => !line.startsWith("  "));
		return rest.slice(0, end === -1 ? undefined : end);
	};

	it("groups Refs by layer: Scoped here, Project, Global, and Scoped elsewhere", () => {
		const text = formatList({
			...base,
			refs: [snippet("g", "1"), snippet("s", "2", { path: "/work/app" }), snippet("e", "3", { path: "/other" })],
			project: project([snippet("p", "4")]),
		});
		assert.deepEqual(sectionOf(text, /^Scoped Refs that apply here, in \/agent\/pi-context-refs\.json \(1 Ref\)$/), [
			'  s  snippet  scope: path /work/app  "2"',
		]);
		assert.deepEqual(sectionOf(text, /^Project library \/work\/app\/\.pi\/pi-context-refs\.json \(1 Ref\)$/), ['  p  snippet  "4"']);
		assert.deepEqual(sectionOf(text, /^Global library \/agent\/pi-context-refs\.json \(1 Ref\)$/), ['  g  snippet  "1"']);
		assert.deepEqual(sectionOf(text, /^Scoped Refs that do not apply here, in /), ['  e  snippet  scope: path /other  "3"']);
		const order = ["Scoped Refs that apply here", "Project library", "Global library", "Scoped Refs that do not apply here"].map((title) =>
			text.indexOf(title),
		);
		assert.deepEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
	});

	it("lists Shadowed Refs with the layer that hides them", () => {
		const text = formatList({
			...base,
			refs: [snippet("a", "global"), snippet("b", "scoped", { path: "/work/app" }), snippet("c", "global")],
			project: project([snippet("a", "project"), snippet("b", "project"), snippet("d", "project")]),
		});
		assert.deepEqual(sectionOf(text, /^Shadowed Refs:$/), [
			"  b  in the Project library, hidden by the Global library, scoped to here",
			"  a  in the Global library, hidden by the Project library",
		]);
	});

	it("has no Shadowed Refs section when nothing is hidden", () => {
		assert.doesNotMatch(formatList({ ...base, refs: [snippet("a", "1")], project: project([snippet("b", "2")]) }), /Shadowed/);
	});

	it("explains an untrusted project and points to /trust and a restart, without listing its Refs", () => {
		const text = formatList({ ...base, refs: [snippet("a", "1")], project: { file: "/work/app/.pi/pi-context-refs.json", untrusted: true } });
		assert.match(
			text,
			/^Project library \/work\/app\/\.pi\/pi-context-refs\.json: not loaded\. pi does not trust this project\. Run \/trust, then restart pi/m,
		);
		assert.doesNotMatch(text, /Project library .*\(/);
	});

	it("shows only one library with in=", () => {
		const input = { ...base, refs: [snippet("g", "1")], project: project([snippet("p", "2")]) };
		const globalOnly = formatList({ ...input, filter: { library: "global" } });
		assert.match(globalOnly, /^Global library /m);
		assert.doesNotMatch(globalOnly, /Project library/);
		const projectOnly = formatList({ ...input, filter: { library: "project" } });
		assert.match(projectOnly, /^Project library /m);
		assert.doesNotMatch(projectOnly, /Global library/);
	});

	it("filters every layer by tag", () => {
		const text = formatList({
			...base,
			refs: [{ ...snippet("g", "1"), tags: ["x"] }, snippet("h", "2")],
			project: project([{ ...snippet("p", "3"), tags: ["X"] }, snippet("q", "4")]),
			filter: { tag: "x" },
		});
		assert.match(text, /^ {2}g /m);
		assert.match(text, /^ {2}p /m);
		assert.doesNotMatch(text, /^ {2}[hq] /m);
	});

	it("lists the warnings of both libraries, and an unusable Project library", () => {
		const text = formatList({
			...base,
			warnings: ["global bad"],
			project: { ...project([], ["project bad"]), error: "/work/app/.pi/pi-context-refs.json does not parse: x" },
		});
		assert.match(text, /\nWarnings:\n {2}global bad\n {2}project bad\n {2}\/work\/app\/\.pi\/pi-context-refs\.json does not parse: x; no Refs are loaded$/);
	});
});
