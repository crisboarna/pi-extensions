import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowOnceConfirm, blockDialog, switchNotice, type DialogCause, type ModelOffer } from "../../src/core/block-dialog.ts";

const context = { home: "/home/me", configPath: "/home/me/.pi/agent/account-guard.json" };
const place = { ok: true as const, path: "/home/me/diary", zone: "personal" };
const current = { provider: "acme", source: "oauth" };
const mismatch: DialogCause = { kind: "zone-mismatch", account: current, accountZones: ["work"], place };

const accounts = [
	{ provider: "acme", source: "oauth", zones: ["work"] },
	{ provider: "beta", source: "oauth", zones: ["personal"] },
	{ provider: "gamma", source: "env:GAMMA_KEY", zones: ["personal", "work"] },
	{ provider: "delta", source: "oauth", zones: ["personal"] },
	{ provider: "omega", source: "oauth", zones: ["work"] },
];
const offers: ModelOffer[] = [
	{ account: current, modelIds: ["mid", "big"] },
	{ account: { provider: "gamma", source: "env:GAMMA_KEY" }, modelIds: ["g1", "g2"] },
	{ account: { provider: "beta", source: "oauth" }, modelIds: ["small", "mid"] },
	{ account: { provider: "omega", source: "oauth" }, modelIds: ["o1"] },
];
const input = { cause: mismatch, place, currentModelId: "mid", accounts, offers, context };

describe("blockDialog", () => {
	it("lists the Switch rows in config order, then the two Overrides, then Cancel", () => {
		const { title, rows } = blockDialog(input);
		assert.equal(title, "BLOCKED  acme (oauth) is zone work\nPlace ~/diary -> zone personal");
		assert.deepEqual(
			rows.map((row) => row.label),
			[
				"Switch to beta (oauth) -> mid  [personal]",
				"Switch to gamma (env:GAMMA_KEY) -> g1  [personal, work]",
				"Allow once: this turn to acme (oauth)",
				"Allow for session: acme (oauth)",
				"Cancel",
			],
		);
	});

	it("keeps the current model id when the target offers it and says when it does not", () => {
		const [kept, fallback] = blockDialog(input).rows;
		assert.equal(kept?.kind === "switch" && kept.modelId, "mid");
		assert.equal(kept?.kind === "switch" && kept.notOffered, undefined);
		assert.equal(fallback?.kind === "switch" && fallback.modelId, "g1");
		assert.equal(fallback?.kind === "switch" && fallback.notOffered, "mid");
		assert.equal(switchNotice(kept as never), "Switched to beta (oauth), sending.");
		assert.equal(switchNotice(fallback as never), "Switched to gamma (env:GAMMA_KEY) using model g1 (mid not offered), sending.");
	});

	it("offers no Switch rows when the place cannot be decided, and keeps both Overrides", () => {
		const cause: DialogCause = { kind: "place-undecidable", account: current, reason: "git failed" };
		const { title, rows } = blockDialog({ ...input, cause, place: { ok: false, reason: "git failed" } });
		assert.equal(title, "BLOCKED  cannot decide the zone of this place (git failed)\nPlace zone unknown");
		assert.deepEqual(
			rows.map((row) => row.kind),
			["allow-once", "allow-session", "cancel"],
		);
	});

	it("names the file and every error when the config is invalid", () => {
		const cause: DialogCause = { kind: "config-invalid", account: current, errors: [{ path: "accounts[2].zones", message: 'unknown zone "wrk"' }] };
		const { title, rows } = blockDialog({ ...input, cause, place: { ok: false, reason: "the config is invalid" }, accounts: [] });
		assert.equal(title, 'BLOCKED  cannot read account-guard.json\naccount-guard.json: accounts[2].zones: unknown zone "wrk"\nPlace zone unknown');
		assert.deepEqual(
			rows.map((row) => row.kind),
			["allow-once", "allow-session", "cancel"],
		);
	});

	it("titles an untagged account", () => {
		const cause: DialogCause = { kind: "unknown-account", account: current, place };
		assert.equal(blockDialog({ ...input, cause }).title, "BLOCKED  acme (oauth) has no zone tag\nPlace ~/diary -> zone personal");
	});
});

describe("allowOnceConfirm", () => {
	it("names the account, its zones and the place zone", () => {
		assert.deepEqual(allowOnceConfirm(mismatch, place, context), {
			title: "Allow once?",
			message: "Send ONE turn to acme (oauth), zone work, from a personal place (~/diary).",
		});
	});
});
