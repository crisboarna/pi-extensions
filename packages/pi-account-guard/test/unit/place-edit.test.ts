import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type GuardConfig } from "../../src/core/config.ts";
import { addPlaceRule, movePlaceRule, placeChangeText, placeListText, placeZoneChanges, removePlaceRule } from "../../src/core/place-edit.ts";

const config: GuardConfig = {
	...DEFAULT_CONFIG,
	places: [
		{ remote: "*/Acme/*", zone: "work" },
		{ path: "~/Projects", zone: "personal", note: "n" },
		{ path: "~/Projects/acme", remote: "*/Acme/*", zone: "work" },
	],
};
const zonesOf = (edited: GuardConfig) => edited.places.map((rule) => rule.zone + (rule.path ?? rule.remote));

describe("place rule edits", () => {
	it("adds a rule at the top, in the middle or at the end", () => {
		const rule = { path: "/tmp", zone: "work" };
		assert.deepEqual(addPlaceRule(config, rule, 0).places[0], rule);
		assert.deepEqual(addPlaceRule(config, rule, 1).places[1], rule);
		assert.deepEqual(addPlaceRule(config, rule, 3).places[3], rule);
		assert.equal(addPlaceRule(config, rule, 3).places.length, 4);
	});

	it("removes a rule and leaves the others in order", () => {
		assert.deepEqual(zonesOf(removePlaceRule(config, 1)), ["work*/Acme/*", "work~/Projects/acme"]);
	});

	it("moves a rule up and down, keeping its note", () => {
		assert.deepEqual(zonesOf(movePlaceRule(config, 2, 0)), ["work~/Projects/acme", "work*/Acme/*", "personal~/Projects"]);
		assert.deepEqual(zonesOf(movePlaceRule(config, 0, 2)), ["personal~/Projects", "work~/Projects/acme", "work*/Acme/*"]);
		assert.equal(movePlaceRule(config, 1, 0).places[0]!.note, "n");
	});

	it("does not change the config it edits", () => {
		removePlaceRule(config, 0);
		assert.equal(config.places.length, 3);
	});
});

describe("placeListText", () => {
	it("numbers the rules in file order and marks the deciding one", () => {
		const place = { ok: true as const, path: "/home/me/Projects/x", zone: "personal", ruleIndex: 1 };
		assert.equal(
			placeListText(config, place),
			[
				"guard place rules",
				" 1. remote */Acme/* -> work",
				" 2. ~/Projects -> personal   <- decides this place",
				" 3. ~/Projects/acme + remote */Acme/* -> work",
				" default zone: personal",
			].join("\n"),
		);
	});

	it("marks the default zone when no rule decides", () => {
		const place = { ok: true as const, path: "/tmp", zone: "personal" };
		assert.match(placeListText(config, place), /^ default zone: personal {3}<- decides this place$/m);
	});

	it("says so when there are no rules, and when the place cannot be decided", () => {
		assert.equal(
			placeListText(DEFAULT_CONFIG, { ok: false, reason: "git failed" }),
			["guard place rules", " this place cannot be decided: git failed", " no rules", " default zone: personal"].join("\n"),
		);
	});
});

describe("placeZoneChanges", () => {
	const at = (zone: string) => ({ ok: true as const, path: "/p", zone });
	const unknown = (reason: string) => ({ ok: false as const, reason });

	it("is true only when the zone differs", () => {
		assert.equal(placeZoneChanges(at("work"), at("work")), false);
		assert.equal(placeZoneChanges(at("work"), at("personal")), true);
	});

	it("is true when the place becomes or stops being undecidable", () => {
		assert.equal(placeZoneChanges(at("work"), unknown("x")), true);
		assert.equal(placeZoneChanges(unknown("x"), at("work")), true);
		assert.equal(placeZoneChanges(unknown("x"), unknown("y")), false);
	});

	it("words the change", () => {
		assert.equal(placeChangeText(at("work"), at("personal")), "This place changes from zone work to zone personal.");
		assert.equal(placeChangeText(at("work"), unknown("git failed")), "This place changes from zone work to unknown (git failed).");
	});
});
