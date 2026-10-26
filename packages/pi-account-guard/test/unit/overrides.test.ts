import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Decision } from "../../src/core/decide.ts";
import { applyOverrides, grantOnce, grantSession, NO_OVERRIDES, releaseOnce, sessionOverrideFooter } from "../../src/core/overrides.ts";

const personal = { ok: true as const, path: "/home/me/diary", zone: "personal" };
const elsewhere = { ok: true as const, path: "/home/me/other", zone: "personal" };
const acme = { provider: "acme", source: "oauth" };
const beta = { provider: "beta", source: "oauth" };
const blockOf = (account = acme, place = personal): Decision => ({
	verdict: "block",
	cause: { kind: "zone-mismatch", account, accountZones: ["work"], place },
});

describe("applyOverrides", () => {
	it("passes a Match untouched and Blocks without an Override", () => {
		assert.deepEqual(applyOverrides({ verdict: "match" }, personal, NO_OVERRIDES), { verdict: "match" });
		assert.deepEqual(applyOverrides(blockOf(), personal, NO_OVERRIDES), blockOf());
	});

	it("lets allow-once pass only its own account in its own place", () => {
		const overrides = grantOnce(NO_OVERRIDES, acme, personal);
		assert.deepEqual(applyOverrides(blockOf(), personal, overrides), { verdict: "override", by: "allow-once" });
		assert.deepEqual(applyOverrides(blockOf(beta), personal, overrides), blockOf(beta));
		assert.deepEqual(applyOverrides(blockOf(acme, elsewhere), elsewhere, overrides), blockOf(acme, elsewhere));
	});

	it("stops allow-once after it is released", () => {
		const overrides = releaseOnce(grantOnce(NO_OVERRIDES, acme, personal));
		assert.deepEqual(applyOverrides(blockOf(), personal, overrides), blockOf());
	});

	it("lets allow-for-session pass one account in any place, and a new grant replaces it", () => {
		const overrides = grantSession(NO_OVERRIDES, acme, personal);
		assert.deepEqual(applyOverrides(blockOf(acme, elsewhere), elsewhere, overrides), { verdict: "override", by: "allow-session" });
		assert.deepEqual(applyOverrides(blockOf(beta), personal, overrides), blockOf(beta));
		const replaced = grantSession(overrides, beta, personal);
		assert.deepEqual(applyOverrides(blockOf(), personal, replaced), blockOf());
	});

	it("keeps the Overrides available on undecidable causes", () => {
		const decision: Decision = { verdict: "block", cause: { kind: "config-invalid", account: acme, errors: [] } };
		const place = { ok: false as const, reason: "the config is invalid" };
		assert.deepEqual(applyOverrides(decision, place, grantSession(NO_OVERRIDES, acme, place)), { verdict: "override", by: "allow-session" });
		assert.deepEqual(applyOverrides(decision, place, grantOnce(NO_OVERRIDES, acme, place)), { verdict: "override", by: "allow-once" });
	});

	it("lets both Overrides cover an internal error of the account's check (ADR 0001)", () => {
		const place = { ok: false as const, reason: "internal error" };
		const decision: Decision = { verdict: "block", cause: { kind: "internal-error", account: acme, reason: "boom" } };
		assert.deepEqual(applyOverrides(decision, place, grantSession(NO_OVERRIDES, acme, place)), { verdict: "override", by: "allow-session" });
		assert.deepEqual(applyOverrides(decision, place, grantOnce(NO_OVERRIDES, acme, place)), { verdict: "override", by: "allow-once" });
		assert.deepEqual(applyOverrides(decision, place, grantSession(NO_OVERRIDES, beta, place)), decision, "another account stays Blocked");
	});
});

describe("sessionOverrideFooter", () => {
	it("shows the account and the zone while a session Override is active", () => {
		assert.equal(sessionOverrideFooter(NO_OVERRIDES), undefined);
		assert.equal(sessionOverrideFooter(grantOnce(NO_OVERRIDES, acme, personal)), undefined);
		assert.equal(sessionOverrideFooter(grantSession(NO_OVERRIDES, acme, personal)), "guard OVERRIDE acme in personal");
	});
});
