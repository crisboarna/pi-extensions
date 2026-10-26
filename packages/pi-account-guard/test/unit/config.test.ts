import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountZones, DEFAULT_CONFIG, formatConfigErrors, parseConfig } from "../../src/core/config.ts";

const parse = (value: unknown) => parseConfig(JSON.stringify(value));

function errorsOf(value: unknown): string[] {
	const result = parse(value);
	assert.equal(result.ok, false, "expected the config to be rejected");
	return result.ok ? [] : formatConfigErrors(result.errors, "account-guard.json");
}

describe("parseConfig", () => {
	it("treats a missing file as the default config", () => {
		assert.deepEqual(parseConfig(undefined), { ok: true, config: DEFAULT_CONFIG });
		assert.deepEqual(DEFAULT_CONFIG, { zones: ["work", "personal"], defaultZone: "personal", accounts: [], places: [] });
	});

	it("applies the default zones and default zone to an empty object", () => {
		assert.deepEqual(parse({}), { ok: true, config: DEFAULT_CONFIG });
	});

	it("reads zones, accounts and path places", () => {
		const result = parse({
			zones: ["work", "home"],
			defaultZone: "home",
			accounts: [{ provider: "acme", source: "oauth", zones: ["work"], note: "seat" }],
			places: [{ path: "~/Projects/co", zone: "work", note: "client" }],
		});
		assert.deepEqual(result, {
			ok: true,
			config: {
				zones: ["work", "home"],
				defaultZone: "home",
				accounts: [{ provider: "acme", source: "oauth", zones: ["work"], note: "seat" }],
				places: [{ path: "~/Projects/co", zone: "work", note: "client" }],
			},
		});
	});

	it("rejects text that is not JSON, naming the file", () => {
		const result = parseConfig("{ nope");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : formatConfigErrors(result.errors, "account-guard.json")[0]!, /^account-guard\.json: invalid JSON: /);
	});

	it("rejects a top level that is not an object", () => {
		assert.deepEqual(errorsOf([]), ["account-guard.json: must be an object"]);
	});

	it("rejects an unknown field at every level, with its JSON path", () => {
		assert.deepEqual(errorsOf({ colour: 1 }), ['account-guard.json: unknown field "colour"']);
		assert.deepEqual(errorsOf({ accounts: [{ provider: "acme", source: "oauth", zones: ["work"], extra: 1 }] }), ['account-guard.json: accounts[0]: unknown field "extra"']);
		assert.deepEqual(errorsOf({ places: [{ path: "/a", zone: "work", extra: 1 }] }), ['account-guard.json: places[0]: unknown field "extra"']);
	});

	it("rejects a duplicate (provider, source) account", () => {
		const account = { provider: "acme", source: "oauth", zones: ["work"] };
		assert.deepEqual(errorsOf({ accounts: [account, { ...account, source: "stored-key" }, account] }), ["account-guard.json: accounts[2]: duplicate of accounts[0] (acme · oauth)"]);
	});

	it("rejects an empty zones list on an account", () => {
		assert.deepEqual(errorsOf({ accounts: [{ provider: "acme", source: "oauth", zones: [] }] }), ["account-guard.json: accounts[0].zones: must list at least one zone"]);
	});

	it("rejects an undeclared zone in a tag, a rule and defaultZone", () => {
		assert.deepEqual(errorsOf({ accounts: [{ provider: "acme", source: "oauth", zones: ["lab"] }] }), ['account-guard.json: accounts[0].zones[0]: zone "lab" is not declared in zones']);
		assert.deepEqual(errorsOf({ places: [{ path: "/a", zone: "lab" }] }), ['account-guard.json: places[0].zone: zone "lab" is not declared in zones']);
		assert.deepEqual(errorsOf({ defaultZone: "lab" }), ['account-guard.json: defaultZone: zone "lab" is not declared in zones']);
	});

	it("rejects the reserved zone name unknown", () => {
		assert.deepEqual(errorsOf({ zones: ["work", "unknown"], defaultZone: "work" }), ['account-guard.json: zones[1]: "unknown" is reserved and cannot be declared']);
	});

	it("rejects a place rule with no usable path", () => {
		assert.deepEqual(errorsOf({ places: [{ zone: "work" }] }), ["account-guard.json: places[0]: needs a path"]);
		assert.deepEqual(errorsOf({ places: [{ path: "relative/dir", zone: "work" }] }), ["account-guard.json: places[0].path: must be absolute or start with ~"]);
	});

	it("reports every error, not only the first", () => {
		assert.equal(errorsOf({ colour: 1, places: [{ zone: "work" }] }).length, 2);
	});

	it("rejects wrong value types", () => {
		assert.deepEqual(errorsOf({ zones: "work" }), ["account-guard.json: zones: must be an array of zone names"]);
		assert.deepEqual(errorsOf({ accounts: [{ provider: 1, source: "oauth", zones: ["work"] }] }), ["account-guard.json: accounts[0].provider: must be a non-empty string"]);
	});
});

describe("accountZones", () => {
	const config = parse({ accounts: [{ provider: "acme", source: "oauth", zones: ["work", "personal"] }] });
	assert.equal(config.ok, true);
	const accounts = config.ok ? config.config.accounts : [];

	it("returns the zones tagged on an account", () => {
		assert.deepEqual(accountZones(accounts, { provider: "acme", source: "oauth" }), ["work", "personal"]);
	});

	it("returns undefined for an untagged account, including the same provider on another source", () => {
		assert.equal(accountZones(accounts, { provider: "acme", source: "stored-key" }), undefined);
	});
});
