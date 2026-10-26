import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTagArguments, parseUntagArguments, sameZones, zoneChangeText } from "../../src/core/guard-command.ts";

const declared = ["work", "personal"];

describe("parseTagArguments", () => {
	it("reads no words as the current account", () => {
		assert.deepEqual(parseTagArguments([], declared), {});
	});

	it("reads a provider alone", () => {
		assert.deepEqual(parseTagArguments(["acme"], declared), { provider: "acme" });
	});

	it("reads provider, source and zones", () => {
		assert.deepEqual(parseTagArguments(["acme", "oauth", "work,personal"], declared), { provider: "acme", source: "oauth", zonesText: "work,personal" });
	});

	it("reads a second word that names declared zones as the zones, leaving the source to default", () => {
		assert.deepEqual(parseTagArguments(["acme", "work"], declared), { provider: "acme", zonesText: "work" });
		assert.deepEqual(parseTagArguments(["acme", "work,", "personal"], declared), { provider: "acme", zonesText: "work, personal" });
	});

	it("reads a comma list as zones even when a name is not declared, so the zone is reported", () => {
		assert.deepEqual(parseTagArguments(["acme", "work,lab"], declared), { provider: "acme", zonesText: "work,lab" });
	});

	it("reads any other second word as the source", () => {
		assert.deepEqual(parseTagArguments(["acme", "env:ACME_KEY"], declared), { provider: "acme", source: "env:ACME_KEY" });
		assert.deepEqual(parseTagArguments(["acme", "oauth", "lab"], declared), { provider: "acme", source: "oauth", zonesText: "lab" });
	});
});

describe("parseUntagArguments", () => {
	it("reads provider and source", () => {
		assert.deepEqual(parseUntagArguments([]), {});
		assert.deepEqual(parseUntagArguments(["acme"]), { provider: "acme" });
		assert.deepEqual(parseUntagArguments(["acme", "oauth"]), { provider: "acme", source: "oauth" });
	});

	it("rejects extra words", () => {
		assert.equal(parseUntagArguments(["acme", "oauth", "work"]), undefined);
	});
});

describe("zone lists", () => {
	it("compares as sets and shows old to new", () => {
		assert.equal(sameZones(["work", "lab"], ["lab", "work"]), true);
		assert.equal(sameZones(["work"], ["work", "lab"]), false);
		assert.equal(zoneChangeText(["work"], ["work", "lab"]), "work -> work, lab");
	});
});
