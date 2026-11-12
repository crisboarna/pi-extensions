import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountKey } from "../../src/core/account.ts";
import type { ConfigResult } from "../../src/core/config.ts";
import type { Decision, PlaceOutcome } from "../../src/core/decide.ts";
import { decideMembers, type MemberRef, parseMembersAnswer } from "../../src/core/members.ts";

describe("parseMembersAnswer", () => {
	it("reads a list of members", () => {
		assert.deepEqual(parseMembersAnswer({ members: [{ provider: "acme", id: "mid" }] }), { status: "members", members: [{ provider: "acme", id: "mid" }] });
	});

	it("turns the router's own error into an invalid answer, without control characters", () => {
		assert.deepEqual(parseMembersAnswer({ error: "config broke\u001b[2J" }), {
			status: "invalid",
			reason: "switchboard could not list its members: config broke?[2J",
		});
	});

	it("rejects every other shape, so a broken answer Blocks instead of passing", () => {
		for (const value of [
			undefined,
			null,
			"acme/mid",
			{},
			{ members: [] },
			{ members: "acme/mid" },
			{ members: [{ provider: "acme" }] },
			{ members: [{ provider: "", id: "mid" }] },
			{ members: [{ provider: "acme", id: 3 }] },
			{ members: Array.from({ length: 1001 }, () => ({ provider: "acme", id: "mid" })) },
		])
			assert.equal(parseMembersAnswer(value).status, "invalid", JSON.stringify(value)?.slice(0, 80));
	});
});

describe("decideMembers", () => {
	const place: PlaceOutcome = { ok: true, path: "/srv/app", zone: "personal" };
	const virtual: AccountKey = { provider: "switchboard", source: "env:virtual" };
	const accounts: Record<string, AccountKey> = {
		"acme/mid": { provider: "acme", source: "stored-key" },
		"acme-2/mid": { provider: "acme-2", source: "oauth" },
		"zen/big": { provider: "zen", source: "stored-key" },
	};
	const config = (zones: Record<string, string[]>): ConfigResult => ({
		ok: true,
		config: {
			zones: ["personal", "work"],
			defaultZone: "personal",
			accounts: Object.entries(zones).map(([key, list]) => {
				const account = accounts[key];
				assert.ok(account, key);
				return { ...account, zones: list };
			}),
			places: [],
		},
	});
	const run = (members: MemberRef[], zones: Record<string, string[]>, passes: (decision: Decision) => boolean = () => false) =>
		decideMembers({ members, place, config: config(zones), virtual, accountOf: (member) => accounts[`${member.provider}/${member.id}`], passes });
	const all = [
		{ provider: "acme", id: "mid" },
		{ provider: "acme-2", id: "mid" },
		{ provider: "zen", id: "big" },
	];

	it("matches when every member's account matches the place", () => {
		assert.deepEqual(run(all, { "acme/mid": ["personal"], "acme-2/mid": ["personal", "work"], "zen/big": ["personal"] }), { verdict: "match" });
	});

	it("blocks on the member whose account is in another zone, naming that account", () => {
		const decision = run(all, { "acme/mid": ["personal"], "acme-2/mid": ["work"], "zen/big": ["personal"] });
		assert.ok(decision.verdict === "block" && decision.cause.kind === "zone-mismatch");
		assert.deepEqual(decision.cause.account, accounts["acme-2/mid"]);
	});

	it("blocks on an untagged member, so the tag prompt asks for that account", () => {
		const decision = run(all, { "acme/mid": ["personal"], "zen/big": ["personal"] });
		assert.ok(decision.verdict === "block" && decision.cause.kind === "unknown-account");
		assert.deepEqual(decision.cause.account, accounts["acme-2/mid"]);
	});

	it("blocks a member pi does not list, on the virtual account so an Override still covers it", () => {
		const decision = run([...all, { provider: "ghost", id: "x" }], { "acme/mid": ["personal"], "acme-2/mid": ["personal"], "zen/big": ["personal"] });
		assert.ok(decision.verdict === "block" && decision.cause.kind === "internal-error");
		assert.deepEqual(decision.cause.account, virtual);
		assert.match(decision.cause.reason, /ghost\/x/u);
	});

	it("still blocks on a later member when an Override covers an earlier one", () => {
		const covered = (decision: Decision) => decision.verdict === "block" && decision.cause.account.provider === "acme";
		const decision = run(all, { "acme/mid": ["work"], "acme-2/mid": ["personal"], "zen/big": ["work"] }, covered);
		assert.ok(decision.verdict === "block");
		assert.deepEqual(decision.cause.account, accounts["zen/big"], "the covered member does not hide the uncovered one");
	});

	it("returns a covered block when every block is covered, so the caller applies and logs the Override", () => {
		const decision = run(all, { "acme/mid": ["work"], "acme-2/mid": ["personal"], "zen/big": ["personal"] }, () => true);
		assert.ok(decision.verdict === "block");
		assert.deepEqual(decision.cause.account, accounts["acme/mid"]);
	});
});
