import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parseConfig } from "../../src/core/config.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const schema = readJson("../../schema/account-guard.schema.json") as object;
const example = readJson("../../examples/account-guard.json");

const ajv = new Ajv2020.default({ strict: true, strictRequired: false, allErrors: true });
const schemaAccepts = ajv.compile(schema);
const guardAccepts = (value: unknown) => parseConfig(JSON.stringify(value)).ok;

const account = { provider: "acme", source: "oauth", zones: ["work"] };

const valid: Record<string, unknown> = {
	"the example config": example,
	"an empty object (all defaults)": {},
	"zones, default zone, accounts and places": { zones: ["work", "home"], defaultZone: "home", accounts: [{ ...account, note: "seat" }], places: [{ path: "~/Projects/co", zone: "work", note: "client" }] },
	"a place rule with a path, a remote or both": { places: [{ path: "/a", zone: "work" }, { path: "~", zone: "work" }, { remote: "*/Acme/*", zone: "work" }, { path: "/a", remote: "*/Acme/*", zone: "personal" }] },
	"one account in several zones": { accounts: [{ ...account, zones: ["work", "personal"] }] },
	"the same provider on two sources": { accounts: [account, { ...account, source: "stored-key" }] },
};

/** Invalid configs the schema also rejects: structure, types and values. */
const structurallyInvalid: Record<string, unknown> = {
	"a top level that is not an object": [],
	"an unknown top-level field": { colour: 1 },
	"an unknown account field": { accounts: [{ ...account, extra: 1 }] },
	"an unknown place field": { places: [{ path: "/a", zone: "work", extra: 1 }] },
	"an empty zones list on an account": { accounts: [{ ...account, zones: [] }] },
	"the reserved zone unknown declared": { zones: ["work", "unknown"], defaultZone: "work" },
	"the reserved zone unknown in a tag": { accounts: [{ ...account, zones: ["unknown"] }] },
	"a place rule with no path and no remote": { places: [{ zone: "work" }] },
	"a place rule with an empty remote": { places: [{ remote: "", zone: "work" }] },
	"a place rule with a remote that is not a string": { places: [{ path: "/a", remote: 3, zone: "work" }] },
	"a relative place path": { places: [{ path: "relative/dir", zone: "work" }] },
	"a place rule with no zone": { places: [{ path: "/a" }] },
	"zones that is not an array": { zones: "work" },
	"an empty zone name": { zones: ["work", ""] },
	"an account with a provider that is not a string": { accounts: [{ ...account, provider: 1 }] },
	"an account with no source": { accounts: [{ provider: "acme", zones: ["work"] }] },
	"an account with zones that is not an array": { accounts: [{ ...account, zones: "work" }] },
	"a note that is not a string": { accounts: [{ ...account, note: 1 }] },
	"accounts that is not an array": { accounts: {} },
	"places that is not an array": { places: {} },
	"a $schema field": { $schema: "https://example.com/schema.json" },
};

/** Invalid configs that need a comparison between fields. Only the guard can reject them. */
const crossReferenceInvalid: Record<string, unknown> = {
	"an undeclared zone in a tag": { accounts: [{ ...account, zones: ["lab"] }] },
	"an undeclared zone in a place rule": { places: [{ path: "/a", zone: "lab" }] },
	"an undeclared default zone": { defaultZone: "lab" },
	"a duplicate (provider, source) account": { accounts: [account, account] },
};

describe("schema/account-guard.schema.json", () => {
	for (const [name, config] of Object.entries(valid)) {
		it(`accepts ${name}, as the guard does`, () => {
			assert.equal(schemaAccepts(config), true, JSON.stringify(schemaAccepts.errors));
			assert.equal(guardAccepts(config), true);
		});
	}

	for (const [name, config] of Object.entries(structurallyInvalid)) {
		it(`rejects ${name}, as the guard does`, () => {
			assert.equal(schemaAccepts(config), false);
			assert.equal(guardAccepts(config), false);
		});
	}

	for (const [name, config] of Object.entries(crossReferenceInvalid)) {
		it(`leaves ${name} to the guard`, () => {
			assert.equal(schemaAccepts(config), true);
			assert.equal(guardAccepts(config), false);
		});
	}
});
