import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DialogCause, ModelOffer } from "../../src/core/block-dialog.ts";
import { blockedBeforeSendNotice, failoverBlockedNotice, midTurnDialog, midTurnSessionNotice, midTurnSwitchNotice } from "../../src/core/mid-turn.ts";

const context = { home: "/home/me", configPath: "/home/me/.pi/agent/account-guard.json" };
const place = { ok: true as const, path: "/home/me/diary", zone: "personal" };
const blocked = { provider: "acme", source: "oauth" };
const mismatch: DialogCause = { kind: "zone-mismatch", account: blocked, accountZones: ["work"], place };

const accounts = [
	{ provider: "beta", source: "oauth", zones: ["personal"] },
	{ provider: "gamma", source: "env:GAMMA_KEY", zones: ["personal", "work"] },
	{ provider: "delta", source: "oauth", zones: ["personal"] },
];
const offers: ModelOffer[] = [
	{ account: { provider: "beta", source: "oauth" }, modelIds: ["small", "mid"] },
	{ account: { provider: "gamma", source: "env:GAMMA_KEY" }, modelIds: ["g1"] },
	{ account: { provider: "delta", source: "oauth" }, modelIds: ["d1", "d2"] },
];
const input = { cause: mismatch, place, currentModelId: "d2", accounts, offers, context };

describe("failoverBlockedNotice", () => {
	it("says a failover was blocked and names the new account, its zones and the place", () => {
		assert.equal(
			failoverBlockedNotice(mismatch, place, context),
			"guard: failover blocked, model changed to acme (oauth) [work] during a turn in a personal place (~/diary). Turn aborted.",
		);
	});

	it("names the cause for an unknown account, a bad config and an undecidable place", () => {
		const unknown: DialogCause = { kind: "unknown-account", account: blocked, place };
		const invalid: DialogCause = { kind: "config-invalid", account: blocked, errors: [] };
		const undecidable: DialogCause = { kind: "place-undecidable", account: blocked, reason: "git failed" };
		const unresolved = { ok: false as const, reason: "git failed" };
		assert.match(failoverBlockedNotice(unknown, place, context), /acme \(oauth\) \[no zone tag\] during a turn in a personal place/);
		assert.match(failoverBlockedNotice(invalid, unresolved, context), /\[cannot read ~\/\.pi\/agent\/account-guard\.json\] during a turn in a place whose zone is unknown/);
		assert.match(failoverBlockedNotice(undecidable, unresolved, context), /\[cannot decide the zone of the place: git failed\]/);
	});
});

describe("blockedBeforeSendNotice", () => {
	it("says no request was sent", () => {
		assert.equal(
			blockedBeforeSendNotice(mismatch, place, context),
			"guard: blocked before sending, the model is acme (oauth) [work] in a personal place (~/diary). Run aborted, no request was sent.",
		);
	});
});

describe("midTurnDialog", () => {
	it("drops Allow once and keeps the rest in order", () => {
		const { title, rows } = midTurnDialog(input, undefined);
		assert.equal(title, "BLOCKED  acme (oauth) is zone work\nPlace ~/diary -> zone personal");
		assert.deepEqual(
			rows.map((row) => row.label),
			[
				"Switch to beta (oauth) -> small  [personal]",
				"Switch to gamma (env:GAMMA_KEY) -> g1  [personal, work]",
				"Switch to delta (oauth) -> d2  [personal]",
				"Allow for session: acme (oauth)",
				"Cancel",
			],
		);
	});

	it("puts the previous account first when it is a Switch row", () => {
		const { rows } = midTurnDialog(input, { provider: "delta", source: "oauth" });
		assert.deepEqual(
			rows.map((row) => row.label),
			[
				"Switch to delta (oauth) -> d2  [personal]",
				"Switch to beta (oauth) -> small  [personal]",
				"Switch to gamma (env:GAMMA_KEY) -> g1  [personal, work]",
				"Allow for session: acme (oauth)",
				"Cancel",
			],
		);
	});

	it("keeps the order when the previous account does not match the place", () => {
		const { rows } = midTurnDialog(input, { provider: "omega", source: "oauth" });
		assert.equal(rows[0]?.label, "Switch to beta (oauth) -> small  [personal]");
	});

	it("has no Switch row and no Allow once for an undecidable place", () => {
		const cause: DialogCause = { kind: "place-undecidable", account: blocked, reason: "git failed" };
		const { rows } = midTurnDialog({ ...input, cause, place: { ok: false, reason: "git failed" } }, undefined);
		assert.deepEqual(
			rows.map((row) => row.kind),
			["allow-session", "cancel"],
		);
	});
});

describe("mid-turn notices after the select", () => {
	it("says the aborted turn is not resumed after a Switch, and when the model id was not offered", () => {
		const [first] = midTurnDialog(input, undefined).rows;
		assert.equal(midTurnSwitchNotice(first as never), "Switched to beta (oauth) using model small (d2 not offered). The aborted turn is not resumed.");
		assert.equal(midTurnSwitchNotice({ kind: "switch", label: "", account: { provider: "gamma", source: "env:GAMMA_KEY" }, modelId: "g1", zones: [] }), "Switched to gamma (env:GAMMA_KEY). The aborted turn is not resumed.");
	});

	it("says the aborted turn is not resumed after Allow for session", () => {
		assert.equal(midTurnSessionNotice(mismatch), "Allowed acme (oauth) for this session. The aborted turn is not resumed.");
	});
});
