import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knownAccountLabel, knownAccounts } from "../../src/core/known-accounts.ts";

const acme = { provider: "acme", source: "oauth" };
const beta = { provider: "beta", source: "env:BETA_KEY" };
const old = { provider: "old", source: "stored-key" };

describe("knownAccounts", () => {
	it("lists configured accounts in registry order with their tags, then file entries not configured now", () => {
		assert.deepEqual(knownAccounts([beta, acme], [{ ...old, zones: ["work"] }, { ...acme, zones: ["personal"] }]), [
			{ key: beta, zones: undefined, configured: true },
			{ key: acme, zones: ["personal"], configured: true },
			{ key: old, zones: ["work"], configured: false },
		]);
	});

	it("tells the same provider id apart by source", () => {
		const other = { provider: "acme", source: "stored-key" };
		assert.deepEqual(knownAccounts([acme], [{ ...other, zones: ["work"] }]).map((known) => [known.key.source, known.configured]), [["oauth", true], ["stored-key", false]]);
	});
});

describe("knownAccountLabel", () => {
	it("shows the zones, untagged, and a mark for an account not configured now", () => {
		assert.equal(knownAccountLabel({ key: acme, zones: ["work", "lab"], configured: true }), "acme (oauth)  [work, lab]");
		assert.equal(knownAccountLabel({ key: beta, zones: undefined, configured: true }), "beta (env:BETA_KEY)  [untagged]");
		assert.equal(knownAccountLabel({ key: old, zones: ["work"], configured: false }), "old (stored-key)  [work]  (not configured now)");
	});
});
