import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNumber, parsePlaceAddArguments, parseTagArguments, parseUntagArguments, sameZones, zoneChangeText, zoneNameProblem } from "../../src/core/guard-command.ts";

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

describe("parsePlaceAddArguments", () => {
	it("reads key=value words in any order", () => {
		assert.deepEqual(parsePlaceAddArguments([]), {});
		assert.deepEqual(parsePlaceAddArguments(["zone=work", "path=here", "remote=*/Acme/*", "at=2"]), { zone: "work", path: "here", remote: "*/Acme/*", at: "2" });
	});

	it("keeps an equals sign inside a value", () => {
		assert.deepEqual(parsePlaceAddArguments(["remote=host/a=b"]), { remote: "host/a=b" });
	});

	it("rejects an unknown key, a bare word, an empty value and a repeated key", () => {
		assert.equal(parsePlaceAddArguments(["color=red"]), undefined);
		assert.equal(parsePlaceAddArguments(["work"]), undefined);
		assert.equal(parsePlaceAddArguments(["zone="]), undefined);
		assert.equal(parsePlaceAddArguments(["zone=work", "zone=personal"]), undefined);
	});
});

describe("parseNumber", () => {
	it("reads a whole number from 1 to the maximum", () => {
		assert.equal(parseNumber("1", 3), 1);
		assert.equal(parseNumber("3", 3), 3);
	});

	it("rejects zero, too large, signed, decimal and non-numeric text", () => {
		for (const text of ["0", "4", "-1", "1.5", "two", "", "1e1"]) assert.equal(parseNumber(text, 3), undefined, text);
	});
});

describe("zoneNameProblem", () => {
	it("refuses a comma, which would split the name in a zone list", () => {
		assert.match(zoneNameProblem("a,b")!, /comma/);
		assert.equal(zoneNameProblem("lab-2"), undefined);
	});
});
