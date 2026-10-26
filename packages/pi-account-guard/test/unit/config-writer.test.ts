import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../../src/core/config.ts";
import { createConfigState } from "../../src/core/config-state.ts";
import { createConfigFileWriter, createConfigWriter, removeAccount, serializeConfig, setAccountZones } from "../../src/core/config-writer.ts";

const acme = { provider: "acme", source: "oauth" };

function writerOver(file: { text: string | undefined }) {
	const state = createConfigState(() => file.text);
	const writes: string[] = [];
	const writer = createConfigWriter({
		readForWrite: state.readForWrite,
		writeText: (text) => {
			writes.push(text);
			file.text = text;
		},
	});
	return { writer, writes };
}

describe("serializeConfig", () => {
	it("spells out the defaults with a 2-space indent and a final newline", () => {
		assert.equal(
			serializeConfig(DEFAULT_CONFIG),
			["{", '  "zones": [', '    "work",', '    "personal"', "  ],", '  "defaultZone": "personal",', '  "accounts": [],', '  "places": []', "}", ""].join(
				"\n",
			),
		);
	});

	it("round-trips through the parser, keeping notes", () => {
		const config = {
			zones: ["work", "lab"],
			defaultZone: "lab",
			accounts: [{ ...acme, zones: ["work"], note: "seat" }],
			places: [{ path: "~/a", remote: "*/x/*", zone: "work", note: "n" }],
		};
		assert.deepEqual(parseConfig(serializeConfig(config)), { ok: true, config });
	});
});

describe("setAccountZones", () => {
	it("appends an untagged account", () => {
		assert.deepEqual(setAccountZones(DEFAULT_CONFIG, acme, ["work"]).accounts, [{ ...acme, zones: ["work"] }]);
	});

	it("replaces the zones of a tagged account and keeps its note and position", () => {
		const config = {
			...DEFAULT_CONFIG,
			accounts: [
				{ ...acme, zones: ["work"], note: "seat" },
				{ provider: "beta", source: "oauth", zones: ["personal"] },
			],
		};
		assert.deepEqual(setAccountZones(config, acme, ["personal", "work"]).accounts, [
			{ ...acme, zones: ["personal", "work"], note: "seat" },
			{ provider: "beta", source: "oauth", zones: ["personal"] },
		]);
	});

	it("does not change the config it is given", () => {
		const config = { ...DEFAULT_CONFIG, accounts: [{ ...acme, zones: ["work"] }] };
		setAccountZones(config, acme, ["personal"]);
		assert.deepEqual(config.accounts, [{ ...acme, zones: ["work"] }]);
	});
});

describe("createConfigWriter", () => {
	it("creates the file from the defaults when it is missing", () => {
		const file = { text: undefined as string | undefined };
		const { writer, writes } = writerOver(file);
		const outcome = writer.update((config) => setAccountZones(config, acme, ["work"]));
		assert.deepEqual(outcome, { ok: true, config: { ...DEFAULT_CONFIG, accounts: [{ ...acme, zones: ["work"] }] } });
		assert.equal(writes.length, 1);
		assert.deepEqual(JSON.parse(writes[0]!), {
			zones: ["work", "personal"],
			defaultZone: "personal",
			accounts: [{ ...acme, zones: ["work"] }],
			places: [],
		});
	});

	it("re-reads the file at every update, so a hand edit made in between is kept", () => {
		const file = { text: undefined as string | undefined };
		const { writer } = writerOver(file);
		writer.update((config) => setAccountZones(config, acme, ["work"]));
		file.text = JSON.stringify({ ...JSON.parse(file.text!), places: [{ path: "/p", zone: "work" }] });
		writer.update((config) => setAccountZones(config, { provider: "beta", source: "oauth" }, ["personal"]));
		const written = parseConfig(file.text);
		assert.ok(written.ok);
		assert.deepEqual(written.config.places, [{ path: "/p", zone: "work" }]);
		assert.equal(written.config.accounts.length, 2);
	});

	it("refuses and writes nothing over a malformed file", () => {
		const file = { text: "{ nope" as string | undefined };
		const { writer, writes } = writerOver(file);
		const outcome = writer.update((config) => setAccountZones(config, acme, ["work"]));
		assert.equal(outcome.ok, false);
		assert.deepEqual(writes, []);
		assert.equal(file.text, "{ nope");
	});

	it("refuses and writes nothing when the change would make the file invalid", () => {
		const { writer, writes } = writerOver({ text: undefined });
		const outcome = writer.update((config) => setAccountZones(config, acme, ["undeclared"]));
		assert.equal(outcome.ok, false);
		assert.ok(!outcome.ok && outcome.errors.some((error) => /not declared in zones/.test(error.message)));
		assert.deepEqual(writes, []);
	});
});

describe("removeAccount", () => {
	it("drops the entry of one account and keeps the rest", () => {
		const other = { provider: "acme", source: "stored-key", zones: ["personal"] };
		const config = { ...DEFAULT_CONFIG, accounts: [{ ...acme, zones: ["work"] }, other] };
		assert.deepEqual(removeAccount(config, acme).accounts, [other]);
		assert.deepEqual(removeAccount(config, { provider: "nope", source: "oauth" }), config);
	});
});

describe("createConfigFileWriter", () => {
	it("writes through the host to the config path, re-reading the file first", () => {
		const file: { text: string | undefined } = { text: undefined };
		const writes: Array<{ path: string; text: string }> = [];
		const writer = createConfigFileWriter(
			createConfigState(() => file.text),
			"/home/me/.pi/agent/account-guard.json",
			(path, text) => {
				writes.push({ path, text });
				file.text = text;
			},
		);
		assert.ok(writer);
		assert.equal(writer.update((config) => setAccountZones(config, acme, ["work"])).ok, true);
		assert.deepEqual(
			writes.map((write) => write.path),
			["/home/me/.pi/agent/account-guard.json"],
		);
		assert.deepEqual(parseConfig(file.text), { ok: true, config: { ...DEFAULT_CONFIG, accounts: [{ ...acme, zones: ["work"] }] } });
	});

	it("is undefined when the host cannot write files", () => {
		assert.equal(
			createConfigFileWriter(
				createConfigState(() => undefined),
				"/home/me/account-guard.json",
				undefined,
			),
			undefined,
		);
	});
});
