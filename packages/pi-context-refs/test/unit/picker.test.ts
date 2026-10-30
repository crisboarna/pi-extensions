import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { foldName } from "../../src/core/names.ts";
import { applyPick, type PickerRow, pickerRows, pickInsertion, placeholderText, withFileForm } from "../../src/core/picker.ts";
import type { UsedFile } from "../../src/core/recent.ts";
import type { Layer } from "../../src/core/resolve.ts";

type Entry = [Layer, Ref];

const file = (name: string, path: string, extra: Partial<Ref> = {}): Ref => ({ name, kind: "file", path, ...extra }) as Ref;
const snippet = (name: string, text: string, extra: Partial<Ref> = {}): Ref => ({ name, kind: "snippet", text, ...extra }) as Ref;
const diff: Ref = { name: "diff", kind: "dynamic", command: ["git", "diff"], description: "Unstaged changes" };

function source(entries: Entry[], inWorkTree = true) {
	return {
		visible: new Map(entries.map(([, ref]) => [foldName(ref.name), ref])),
		layers: new Map(entries.map(([layer, ref]) => [foldName(ref.name), layer])),
		inWorkTree,
	};
}

const names = (rows: PickerRow[]) => rows.map((row) => row.name);

describe("pickerRows", () => {
	const all: Entry[] = [
		["scoped", file("mine", "notes.md", { description: "My notes" })],
		["project", file("api", "src/api.ts", { description: "The API", tags: ["backend"] })],
		["project", snippet("rules", "Be terse", { tags: ["backend", "style"] })],
		["global", snippet("terse", "Answer briefly")],
		["builtin", diff],
	];

	it("groups a bare Trigger's rows by section: scoped, project, global, built-in, bundles", () => {
		const rows = pickerRows(source(all), "");
		assert.deepEqual(names(rows), ["mine", "api", "rules", "terse", "diff", "tag:backend", "tag:style"]);
		assert.deepEqual(
			rows.map((row) => row.section),
			["scoped", "project", "project", "global", "builtin", "bundle", "bundle"],
		);
	});

	it("marks each row's layer and shows name, kind and description", () => {
		const rows = pickerRows(source(all), "");
		const byName = (name: string) => rows.find((row) => row.name === name);
		assert.deepEqual(
			["mine", "api", "terse", "diff", "tag:backend"].map((name) => byName(name)?.mark),
			["◆", "■", "●", "○", "⧉"],
		);
		assert.equal(byName("mine")?.kind, "file");
		assert.equal(byName("mine")?.description, "My notes");
		assert.equal(byName("diff")?.description, "built-in · Unstaged changes");
		assert.equal(byName("terse")?.description, '"Answer briefly"', "a Ref without a description shows its target");
		assert.equal(byName("tag:backend")?.kind, "bundle");
		assert.equal(byName("tag:backend")?.description, "2 Refs: api, rules");
	});

	it("strips control characters from a description", () => {
		const rows = pickerRows(source([["global", file("x", "x", { description: "a\u001b[31mred\nline" })]]), "");
		assert.equal(rows[0]?.description, "a [31mred line");
	});

	it("orders rows within a section by relevance, then library order", () => {
		const rows = pickerRows(
			source([
				["global", snippet("my-api", "a")],
				["global", snippet("apiary", "b")],
				["global", snippet("api", "c")],
				["global", snippet("other", "d", { tags: ["api"] })],
			]),
			"api",
		);
		assert.deepEqual(names(rows), ["api", "apiary", "my-api", "other", "tag:api"]);
	});

	it("keeps sections together whatever the relevance", () => {
		const rows = pickerRows(
			source([
				["project", snippet("my-api", "a")],
				["global", snippet("api", "b")],
			]),
			"api",
		);
		assert.deepEqual(names(rows), ["my-api", "api"]);
	});

	it("matches case-insensitively", () => {
		assert.deepEqual(names(pickerRows(source(all), "TER")), ["terse"]);
	});

	it("matches a Ref by its Tag and a Bundle by its Tag or tag:<tag>", () => {
		assert.deepEqual(names(pickerRows(source(all), "style")), ["rules", "tag:style"]);
		assert.deepEqual(names(pickerRows(source(all), "tag:back")), ["tag:backend"]);
		assert.deepEqual(names(pickerRows(source(all), "tag:")), ["tag:backend", "tag:style"]);
	});

	it("returns no rows when nothing matches", () => {
		assert.deepEqual(pickerRows(source(all), "zzz"), []);
	});

	it("hides Built-in Refs outside a git work tree, and keeps a saved Ref that shadows one", () => {
		assert.deepEqual(
			names(
				pickerRows(
					source(
						[
							["builtin", diff],
							["global", snippet("terse", "x")],
						],
						false,
					),
					"",
				),
			),
			["terse"],
		);
		assert.deepEqual(names(pickerRows(source([["global", snippet("diff", "mine")]], false), "")), ["diff"]);
	});

	it("lists a Tag once, under the spelling it was first written, with every member", () => {
		const rows = pickerRows(
			source([
				["global", snippet("a", "1", { tags: ["Docs"] })],
				["global", snippet("b", "2", { tags: ["docs"] })],
			]),
			"",
		);
		assert.deepEqual(names(rows), ["a", "b", "tag:Docs"]);
		assert.equal(rows[2]?.description, "2 Refs: a, b");
	});

	it("cuts a long member list", () => {
		const members = Array.from({ length: 12 }, (_, index): Entry => ["global", snippet(`member-${index}`, "x", { tags: ["big"] })]);
		const bundle = pickerRows(source(members), "tag:big")[0];
		assert.match(bundle?.description ?? "", /^12 Refs: member-0, .*…$/);
	});

	it("says 1 Ref for a Bundle of one", () => {
		assert.match(pickerRows(source([["global", snippet("a", "1", { tags: ["t"] })]]), "tag:t")[0]?.description ?? "", /^1 Ref: a$/);
	});
});

describe("applyPick", () => {
	const rows = pickerRows(
		source([
			["global", snippet("a", "1", { tags: ["t"] })],
			["global", snippet("b", "2", { tags: ["t"] })],
			["global", snippet("c", "3", { tags: ["t"] })],
		]),
		"",
	);
	const row = (name: string): string => rows.find((candidate) => candidate.name === name)?.value ?? "";

	it("replaces the typed token with the Placeholder", () => {
		assert.deepEqual(applyPick(["see #a"], 0, 6, row("a"), "#a"), { lines: ["see [ref:a]"], cursorLine: 0, cursorCol: 11 });
	});

	it("keeps the text after the cursor and works on any line", () => {
		assert.deepEqual(applyPick(["first", "x #b, then"], 1, 4, row("b"), "#b"), { lines: ["first", "x [ref:b], then"], cursorLine: 1, cursorCol: 9 });
	});

	it("inserts one Placeholder per Bundle member", () => {
		assert.deepEqual(applyPick(["#"], 0, 1, row("tag:t"), "#"), { lines: ["[ref:a] [ref:b] [ref:c]"], cursorLine: 0, cursorCol: 23 });
	});

	it("skips Bundle members the draft already has, by Placeholder or typed name, in any case", () => {
		const result = applyPick(["[ref:B] and #c then #"], 0, 21, row("tag:t"), "#");
		assert.deepEqual(result, { lines: ["[ref:B] and #c then [ref:a]"], cursorLine: 0, cursorCol: 27 });
	});

	it("sees members on other lines of the draft", () => {
		const result = applyPick(["[ref:a]", "#"], 1, 1, row("tag:t"), "#");
		assert.deepEqual(result?.lines, ["[ref:a]", "[ref:b] [ref:c]"]);
	});

	it("removes the typed token when the draft has every member", () => {
		const result = applyPick(["[ref:a] [ref:b] [ref:c] #"], 0, 25, row("tag:t"), "#");
		assert.deepEqual(result, { lines: ["[ref:a] [ref:b] [ref:c] "], cursorLine: 0, cursorCol: 24 });
	});

	it("does not take the typed token itself for a member", () => {
		assert.deepEqual(applyPick(["#a"], 0, 2, row("tag:t"), "#a")?.lines, ["[ref:a] [ref:b] [ref:c]"]);
	});

	it("ignores a value that is not one of its rows", () => {
		assert.equal(applyPick(["#42"], 0, 3, "#42", "#42"), undefined);
		assert.equal(applyPick(["#42"], 0, 3, "ref:a", "#42"), undefined);
	});
});

describe("Recent refs in the picker", () => {
	const env = { cwd: "/work/app", home: "/home/me" };
	const NOW = 10_000_000;
	const MINUTE = 60_000;
	const recentFile = (path: string, ago: number, use: "read" | "edit" = "read"): UsedFile => ({ path, use, at: NOW - ago });
	const withRecent = (files: UsedFile[], options: { present?: (path: string) => boolean; entries?: Entry[] } = {}) => ({
		...source(options.entries ?? []),
		recent: { files, env, now: NOW, present: options.present ?? (() => true) },
	});

	it("puts a Recent row after the built-in rows and before the Bundles, marked with ↺, with its note", () => {
		const rows = pickerRows(
			withRecent([recentFile("/work/app/src/api.ts", 5 * MINUTE, "edit")], {
				entries: [
					["builtin", diff],
					["global", snippet("terse", "x", { tags: ["style"] })],
				],
			}),
			"",
		);
		assert.deepEqual(
			rows.map((row) => [row.section, row.name]),
			[
				["global", "terse"],
				["builtin", "diff"],
				["recent", "src/api.ts"],
				["bundle", "tag:style"],
			],
		);
		const recent = rows[2];
		assert.equal(recent?.mark, "↺");
		assert.equal(recent?.kind, "recent");
		assert.equal(recent?.description, "edited 5 min ago");
	});

	it("keeps the files in the order given (newest first)", () => {
		const rows = pickerRows(withRecent([recentFile("/work/app/b.ts", MINUTE), recentFile("/work/app/a.ts", 2 * MINUTE)]), "");
		assert.deepEqual(names(rows), ["b.ts", "a.ts"]);
	});

	it("shows only the 10 newest for a bare Trigger and searches all of them for a query", () => {
		const files = Array.from({ length: 15 }, (_, index) => recentFile(`/work/app/f${index}.ts`, (index + 1) * MINUTE));
		assert.deepEqual(
			names(pickerRows(withRecent(files), "")),
			files.slice(0, 10).map((file) => `f${files.indexOf(file)}.ts`),
		);
		assert.deepEqual(names(pickerRows(withRecent(files), "f14")), ["f14.ts"]);
		assert.equal(pickerRows(withRecent(files), ".ts").length, 15);
	});

	it("counts the 10 among files that are present, so a missing newest file does not use a place", () => {
		const files = Array.from({ length: 12 }, (_, index) => recentFile(`/work/app/f${index}.ts`, (index + 1) * MINUTE));
		const rows = pickerRows(withRecent(files, { present: (path) => !path.endsWith("/f0.ts") }), "");
		assert.deepEqual(
			names(rows),
			files.slice(1, 11).map((file) => file.path.split("/").pop()),
		);
	});

	it("hides a file that is missing", () => {
		const rows = pickerRows(
			withRecent([recentFile("/work/app/gone.ts", MINUTE), recentFile("/work/app/here.ts", MINUTE)], { present: (path) => path.endsWith("here.ts") }),
			"",
		);
		assert.deepEqual(names(rows), ["here.ts"]);
	});

	it("hides the target of a saved Path or File Ref, relative to the working directory or with ~", () => {
		const rows = pickerRows(
			withRecent([recentFile("/work/app/AGENTS.md", MINUTE), recentFile("/home/me/notes.md", MINUTE), recentFile("/work/app/other.ts", MINUTE)], {
				entries: [
					["global", file("agents", "AGENTS.md")],
					["project", { name: "notes", kind: "path", path: "~/notes.md" }],
				],
			}),
			"",
		);
		assert.deepEqual(
			rows.filter((row) => row.section === "recent").map((row) => row.name),
			["other.ts"],
		);
	});

	it("matches the shown path, case-insensitively, so a typed #src/api.ts finds its row", () => {
		const rows = pickerRows(withRecent([recentFile("/work/app/src/api.ts", MINUTE), recentFile("/work/app/src/other.ts", MINUTE)]), "SRC/api.ts");
		assert.deepEqual(names(rows), ["src/api.ts"]);
		assert.deepEqual(pickerRows(withRecent([recentFile("/work/app/src/api.ts", MINUTE)]), "nothing-like-it"), []);
	});

	it("gives a row whose value inserts the path Placeholder", () => {
		const [row] = pickerRows(withRecent([recentFile("/work/app/README.md", MINUTE), recentFile("/work/app/my dir/a b.ts", MINUTE)]), "readme");
		assert.deepEqual(applyPick(["see #readme"], 0, 11, row?.value ?? "", "#readme"), { lines: ["see [ref:./README.md]"], cursorLine: 0, cursorCol: 21 });
	});

	it("quotes a path with spaces in the Placeholder", () => {
		const [row] = pickerRows(withRecent([recentFile("/work/app/my dir/a b.ts", MINUTE)]), "");
		assert.equal(applyPick(["#"], 0, 1, row?.value ?? "", "#")?.lines[0], '[ref:"my dir/a b.ts"]');
	});

	it("inserts a path the draft already has, because a single pick always adds its Placeholder", () => {
		const [row] = pickerRows(withRecent([recentFile("/work/app/src/a.ts", MINUTE)]), "");
		assert.deepEqual(applyPick(["[ref:src/a.ts] and #"], 0, 20, row?.value ?? "", "#")?.lines, ["[ref:src/a.ts] and [ref:src/a.ts]"]);
	});

	it("inserts a saved Ref the draft already has", () => {
		const [row] = pickerRows(source([["global", snippet("a", "1")]]), "");
		assert.deepEqual(applyPick(["[ref:a] and #"], 0, 13, row?.value ?? "", "#")?.lines, ["[ref:a] and [ref:a]"]);
	});

	it("shows no Recent rows when the session has none to offer", () => {
		assert.deepEqual(pickerRows(source([["global", snippet("a", "1")]]), ""), pickerRows(withRecent([], { entries: [["global", snippet("a", "1")]] }), ""));
	});
});

describe("a Recent row in file form", () => {
	const env = { cwd: "/work/app", home: "/home/me" };
	const rowFor = (path: string): PickerRow => {
		const recent = { files: [{ path, use: "read" as const, at: 0 }], env, now: 60_000, present: () => true };
		const [row] = pickerRows({ ...source([]), recent }, "");
		if (!row) throw new Error("no row");
		return row;
	};

	it("inserts [ref:file:<path>] where the path form inserts [ref:<path>]", () => {
		const row = rowFor("/work/app/src/api.ts");
		assert.equal(applyPick(["#"], 0, 1, row.value, "#")?.lines[0], "[ref:src/api.ts]");
		assert.equal(applyPick(["#"], 0, 1, withFileForm(row).value, "#")?.lines[0], "[ref:file:src/api.ts]");
	});

	it("keeps a root file's ./ and quotes a path with spaces", () => {
		assert.equal(applyPick(["#"], 0, 1, withFileForm(rowFor("/work/app/README.md")).value, "#")?.lines[0], "[ref:file:./README.md]");
		assert.equal(applyPick(["#"], 0, 1, withFileForm(rowFor("/work/app/my dir/a b.ts")).value, "#")?.lines[0], '[ref:file:"my dir/a b.ts"]');
	});

	it("says in the description that the contents are sent, and keeps the rest of the row", () => {
		const row = rowFor("/work/app/src/api.ts");
		const switched = withFileForm(row);
		assert.equal(switched.description, `sends its contents · ${row.description}`);
		assert.deepEqual([switched.section, switched.name, switched.mark, switched.path], [row.section, row.name, row.mark, "/work/app/src/api.ts"]);
	});

	it("leaves a row that is not a Recent row as it is", () => {
		const [row] = pickerRows(source([["global", snippet("a", "1")]]), "");
		assert.deepEqual(withFileForm(row as PickerRow), row);
	});
});

describe("pickInsertion", () => {
	const [row] = pickerRows(source([["global", snippet("a", "1")]]), "");
	const value = row?.value ?? "";

	it("gives the Placeholder text and how many characters before the cursor it replaces", () => {
		assert.deepEqual(pickInsertion(["see #a"], 0, 6, value, "#a"), { text: "[ref:a]", replace: 2 });
		assert.deepEqual(pickInsertion(["see "], 0, 4, value, ""), { text: "[ref:a]", replace: 0 });
	});

	it("is empty text when the draft has every member of a Bundle", () => {
		const [bundle] = pickerRows(source([["global", { ...snippet("a", "1"), tags: ["t"] }]]), "tag:t");
		assert.deepEqual(pickInsertion(["[ref:a] #"], 0, 9, bundle?.value ?? "", "#"), { text: "", replace: 1 });
	});

	it("ignores a value that is not one of its rows", () => {
		assert.equal(pickInsertion(["#"], 0, 1, "other", "#"), undefined);
	});
});

describe("placeholderText", () => {
	it("is what a pick of the row inserts into an empty draft", () => {
		const entries: Entry[] = [
			["global", snippet("a", "1", { tags: ["t"] })],
			["global", snippet("b", "2", { tags: ["t"] })],
		];
		const rows = pickerRows(source(entries), "");
		const text = (name: string) => placeholderText(rows.find((row) => row.name === name) as PickerRow);
		assert.equal(text("a"), "[ref:a]");
		assert.equal(text("tag:t"), "[ref:a] [ref:b]");
	});
});
