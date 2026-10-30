import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { APPROVALS_SCHEMA_URL, definitionOf, hashDefinition, readApprovals, updateApprovals, withApproval } from "../../src/core/approval.ts";

const schema = JSON.parse(readFileSync(new URL("../../schema/pi-context-refs-approvals.schema.json", import.meta.url), "utf8")) as { $id: string };
const ajv = new Ajv2020.default({ strict: true, allErrors: true, formats: { "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/ } });
const schemaAccepts = ajv.compile(schema);

const entry = {
	project: "/work/app",
	name: "tests",
	hash: "a".repeat(64),
	definition: "command npm test (in /work/app)",
	approvedAt: "2026-10-30T10:00:00.000Z",
};

describe("the approvals schema", () => {
	it("is the file that APPROVALS_SCHEMA_URL points to", () => {
		assert.equal(schema.$id, APPROVALS_SCHEMA_URL);
	});

	it("accepts a file the package wrote, and the loader reads every entry of it", () => {
		const disk: { text?: string } = {};
		const file = {
			path: "f.json",
			read: () => disk.text,
			write: (text: string) => {
				disk.text = text;
			},
		};
		const hash = hashDefinition(definitionOf({ name: "tests", kind: "dynamic", command: ["npm", "test"] }, "/work/app"));
		updateApprovals(file, (list) => withApproval(list, { ...entry, hash }));
		assert.equal(schemaAccepts(JSON.parse(disk.text ?? "")), true, JSON.stringify(schemaAccepts.errors));
		const read = readApprovals(file);
		assert.deepEqual(read.ok ? read.approvals.map((approval) => approval.name) : read.error, ["tests"]);
	});

	it("accepts a file with no Approvals", () => {
		assert.equal(schemaAccepts({ version: 1 }), true);
		assert.equal(schemaAccepts({ version: 1, approvals: [] }), true);
	});

	it("rejects a wrong version, a missing field, a short hash, an unknown field and a bad date", () => {
		const bad = [
			{ version: 2, approvals: [] },
			{ version: 1, approvals: [{ ...entry, hash: undefined }] },
			{ version: 1, approvals: [{ ...entry, hash: "abc" }] },
			{ version: 1, approvals: [{ ...entry, extra: true }] },
			{ version: 1, approvals: [{ ...entry, approvedAt: "yesterday" }] },
			{ version: 1, approvals: "all" },
		];
		for (const file of bad) assert.equal(schemaAccepts(file), false, JSON.stringify(file));
	});
});
