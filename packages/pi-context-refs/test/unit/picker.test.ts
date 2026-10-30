import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { foldName } from "../../src/core/names.ts";
import { applyPick, type PickerRow, pickerRows } from "../../src/core/picker.ts";
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
