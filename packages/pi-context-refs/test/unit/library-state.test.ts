import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLibraryState } from "../../src/core/library-state.ts";

const FILE = "/agent/pi-context-refs.json";
const library = (...names: string[]) => JSON.stringify({ version: 1, refs: names.map((name) => ({ name, kind: "snippet", text: name })) });

function rig(initial: string | undefined) {
	const disk: { text: string | undefined; failure?: Error } = { text: initial };
	const state = createLibraryState(FILE, () => {
		if (disk.failure) throw disk.failure;
		return disk.text;
	});
	return { disk, state };
}

const names = (refs: readonly { name: string }[]) => refs.map((ref) => ref.name);

describe("library state with a check on each Ref", () => {
	it("checks the last good copy again while the file does not parse, so a Ref that stopped passing is dropped", () => {
		let allowed = true;
		const disk = { text: library("a", "b") };
		const state = createLibraryState(
			FILE,
			() => disk.text,
			(ref) => (ref.name === "b" && !allowed ? { field: "path", message: "now outside the project" } : undefined),
		);
		assert.deepEqual(names(state.refresh().refs), ["a", "b"]);
		disk.text = "{ not json";
		allowed = false;
		const result = state.refresh();
		assert.deepEqual(names(result.refs), ["a"]);
		assert.ok(
			result.notices.some((notice) => /b.*now outside the project/.test(notice)),
			result.notices.join("\n"),
		);
	});
});

describe("library state", () => {
	it("is an empty library when the file is missing, with nothing to report", () => {
		const { state } = rig(undefined);
		const result = state.refresh();
		assert.deepEqual(result.refs, []);
		assert.deepEqual(result.notices, []);
	});

	it("loads the Refs of the file", () => {
		const { state } = rig(library("a", "b"));
		assert.deepEqual(names(state.refresh().refs), ["a", "b"]);
	});

	it("reads the file again on every refresh and picks up a change", () => {
		const { disk, state } = rig(library("a"));
		assert.deepEqual(names(state.refresh().refs), ["a"]);
		disk.text = library("a", "b");
		assert.deepEqual(names(state.refresh().refs), ["a", "b"]);
	});

	it("becomes empty when the file is deleted", () => {
		const { disk, state } = rig(library("a"));
		state.refresh();
		disk.text = undefined;
		assert.deepEqual(state.refresh().refs, []);
	});

	it("reports each warning once, even though the same file is read again", () => {
		const text = JSON.stringify({
			version: 1,
			refs: [
				{ name: "bad name", kind: "snippet", text: "x" },
				{ name: "ok", kind: "snippet", text: "x" },
			],
		});
		const { disk, state } = rig(text);
		const first = state.refresh();
		assert.equal(first.notices.length, 1);
		assert.match(first.notices[0] ?? "", /^\/agent\/pi-context-refs\.json \$\.refs\[0\]\.name: /);
		assert.deepEqual(state.refresh().notices, []);
		disk.text = text.replace('"ok"', '"ok2"');
		assert.deepEqual(state.refresh().notices, [], "an edit that leaves the warning in place does not repeat it");
	});

	it("reports a new warning after an edit", () => {
		const { disk, state } = rig(library("a"));
		state.refresh();
		disk.text = JSON.stringify({ version: 1, refs: [{ name: "bad name", kind: "snippet", text: "x" }] });
		assert.equal(state.refresh().notices.length, 1);
	});

	it("keeps the last good copy when the file stops parsing, and says so once", () => {
		const { disk, state } = rig(library("a"));
		state.refresh();
		disk.text = "{ half saved";
		const broken = state.refresh();
		assert.deepEqual(names(broken.refs), ["a"]);
		assert.equal(broken.notices.length, 1);
		assert.match(broken.notices[0] ?? "", /does not parse.*keeping the last good copy/);
		assert.deepEqual(state.refresh().notices, []);
		disk.text = library("a", "b");
		assert.deepEqual(names(state.refresh().refs), ["a", "b"], "a fixed file loads again");
	});

	it("starts empty, and says so, when the first read does not parse", () => {
		const { state } = rig("{ half saved");
		const result = state.refresh();
		assert.deepEqual(result.refs, []);
		assert.match(result.notices[0] ?? "", /does not parse.*no Refs are loaded/);
	});

	it("treats a file that cannot be read like one that does not parse", () => {
		const { disk, state } = rig(library("a"));
		state.refresh();
		disk.failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		const result = state.refresh();
		assert.deepEqual(names(result.refs), ["a"]);
		assert.match(result.notices[0] ?? "", /could not be read: EACCES: permission denied.*keeping the last good copy/);
	});

	it("keeps the last good copy when the file has the wrong version", () => {
		const { disk, state } = rig(library("a"));
		state.refresh();
		disk.text = JSON.stringify({ version: 2, refs: [] });
		const result = state.refresh();
		assert.deepEqual(names(result.refs), ["a"]);
		assert.match(result.notices[0] ?? "", /\$\.version must be 1.*keeping the last good copy/);
	});
});
