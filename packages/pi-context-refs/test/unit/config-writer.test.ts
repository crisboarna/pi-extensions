import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCHEMA_URL, updateLibraryFile } from "../../src/core/config-writer.ts";

const FILE = "/agent/pi-context-refs.json";

function rig(initial: string | undefined) {
	const disk: { text: string | undefined; writes: string[]; failure?: Error } = { text: initial, writes: [] };
	const file = {
		path: FILE,
		read: () => {
			if (disk.failure) throw disk.failure;
			return disk.text;
		},
		write: (text: string) => {
			disk.writes.push(text);
			disk.text = text;
		},
	};
	return { disk, file };
}

const snippet = { name: "terse", kind: "snippet", text: "Be brief." };
const append = (refs: unknown[]) => ({ refs: [...refs, snippet] });

describe("updateLibraryFile", () => {
	it("creates a missing file with version and $schema, a 2-space indent and a final newline", () => {
		const { disk, file } = rig(undefined);
		const result = updateLibraryFile(file, append);
		assert.deepEqual(result, { ok: true });
		assert.equal(disk.text, `${JSON.stringify({ version: 1, $schema: SCHEMA_URL, refs: [snippet] }, null, 2)}\n`);
		assert.match(disk.text ?? "", /\n {2}"version": 1,\n/);
	});

	it("keeps version, $schema and keys it does not know, including the settings", () => {
		const original = { $schema: "https://example.com/mine.json", version: 1, trigger: "$", builtins: ["log"], future: { a: [1] }, refs: [] };
		const { disk, file } = rig(JSON.stringify(original));
		assert.deepEqual(updateLibraryFile(file, append), { ok: true });
		assert.deepEqual(JSON.parse(disk.text ?? ""), { ...original, refs: [snippet] });
		assert.deepEqual(Object.keys(JSON.parse(disk.text ?? "")), ["$schema", "version", "trigger", "builtins", "future", "refs"]);
	});

	it("normalizes hand formatting to a 2-space indent", () => {
		const { disk, file } = rig('{"version":1,"refs":[]}');
		updateLibraryFile(file, append);
		assert.match(disk.text ?? "", /^\{\n {2}"version": 1,\n {2}"refs": \[\n {4}\{/);
	});

	it("hands the change the Refs of the file as it is on disk right now", () => {
		const { disk, file } = rig(JSON.stringify({ version: 1, refs: [snippet] }));
		const seen: unknown[] = [];
		disk.text = JSON.stringify({ version: 1, refs: [snippet, { name: "other", kind: "path", path: "a" }] });
		updateLibraryFile(file, (refs) => {
			seen.push(...refs);
			return { refs };
		});
		assert.equal(seen.length, 2);
	});

	it("keeps a Ref that is invalid in the file rather than dropping the user's data", () => {
		const bad = { name: "bad name", kind: "snippet", text: "x" };
		const { disk, file } = rig(JSON.stringify({ version: 1, refs: [bad] }));
		updateLibraryFile(file, append);
		assert.deepEqual(JSON.parse(disk.text ?? "").refs, [bad, snippet]);
	});

	it("refuses a file that does not parse, naming the file, and writes nothing", () => {
		const { disk, file } = rig("{ half saved");
		const result = updateLibraryFile(file, append);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /^\/agent\/pi-context-refs\.json does not parse: /);
		assert.deepEqual(disk.writes, []);
		assert.equal(disk.text, "{ half saved");
	});

	it("refuses a file whose version is not 1, whose top level is not an object, or whose refs is not a list", () => {
		for (const text of ['{"version":2,"refs":[]}', "[]", '{"version":1,"refs":{}}', "null"]) {
			const { disk, file } = rig(text);
			const result = updateLibraryFile(file, append);
			assert.equal(result.ok, false, text);
			assert.deepEqual(disk.writes, [], text);
		}
	});

	it("refuses a file that cannot be read, writing nothing", () => {
		const { disk, file } = rig("{}");
		disk.failure = new Error("EACCES");
		const result = updateLibraryFile(file, append);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /could not be read: EACCES/);
		assert.deepEqual(disk.writes, []);
	});

	it("writes nothing and reports the reason when the change refuses", () => {
		const { disk, file } = rig(JSON.stringify({ version: 1, refs: [] }));
		const result = updateLibraryFile(file, () => ({ error: "nope" }));
		assert.deepEqual(result, { ok: false, error: "nope" });
		assert.deepEqual(disk.writes, []);
	});

	it("reports a failed write instead of throwing", () => {
		const { file } = rig(undefined);
		const result = updateLibraryFile(
			{
				...file,
				write: () => {
					throw new Error("disk full");
				},
			},
			append,
		);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /could not be written: disk full/);
	});
});
