import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuardConfig } from "../../src/core/config.ts";
import { addZone, removeZone, renameZone, setDefaultZone, zoneReferences } from "../../src/core/zone-edit.ts";

const config: GuardConfig = {
	zones: ["work", "personal", "lab"],
	defaultZone: "personal",
	accounts: [
		{ provider: "acme", source: "oauth", zones: ["work", "lab"], note: "seat" },
		{ provider: "beta", source: "stored-key", zones: ["personal"] },
	],
	places: [
		{ path: "~/a", zone: "work", note: "n" },
		{ remote: "*/Acme/*", zone: "lab" },
		{ path: "~/b", zone: "work" },
	],
};

describe("zone edits", () => {
	it("adds a zone once", () => {
		assert.deepEqual(addZone(config, "ops").zones, ["work", "personal", "lab", "ops"]);
		assert.equal(addZone(config, "work"), config);
	});

	it("removes a declaration", () => {
		assert.deepEqual(removeZone(config, "lab").zones, ["work", "personal"]);
	});

	it("renames the declaration, every tag, every rule and the default zone, keeping notes and order", () => {
		const renamed = renameZone(config, "work", "job");
		assert.deepEqual(renamed.zones, ["job", "personal", "lab"]);
		assert.deepEqual(renamed.accounts[0], { provider: "acme", source: "oauth", zones: ["job", "lab"], note: "seat" });
		assert.deepEqual(renamed.places, [
			{ path: "~/a", zone: "job", note: "n" },
			{ remote: "*/Acme/*", zone: "lab" },
			{ path: "~/b", zone: "job" },
		]);
		assert.equal(renameZone(config, "personal", "home").defaultZone, "home");
		assert.equal(renameZone(config, "work", "job").defaultZone, "personal");
	});

	it("sets the default zone", () => {
		assert.equal(setDefaultZone(config, "work").defaultZone, "work");
	});
});

describe("zoneReferences", () => {
	it("lists tags, numbered rules and the default zone", () => {
		assert.deepEqual(zoneReferences(config, "work"), ["tag acme (oauth)", "rule 1: ~/a -> work", "rule 3: ~/b -> work"]);
		assert.deepEqual(zoneReferences(config, "personal"), ["tag beta (stored-key)", "the default zone"]);
	});

	it("is empty for a zone nothing names", () => {
		assert.deepEqual(zoneReferences({ ...config, zones: [...config.zones, "ops"] }, "ops"), []);
	});
});
