import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type GuardConfig } from "../../src/core/config.ts";
import { footerText, type FooterInput } from "../../src/core/footer.ts";
import { grantOnce, grantSession, NO_OVERRIDES } from "../../src/core/overrides.ts";

const acme = { provider: "acme", source: "oauth" };
const beta = { provider: "beta", source: "oauth" };
const personal = { ok: true as const, path: "/home/me/diary", zone: "personal" };
const config = (accounts: GuardConfig["accounts"]): FooterInput["config"] => ({ ok: true, config: { ...DEFAULT_CONFIG, accounts } });

const input = (over: Partial<FooterInput> = {}): FooterInput => ({
	place: personal,
	account: acme,
	config: config([{ ...acme, zones: ["personal"] }]),
	usingLastValid: false,
	overrides: NO_OVERRIDES,
	...over,
});

describe("footerText", () => {
	it("shows the place zone and a check on a Match, without the account", () => {
		assert.equal(footerText(input()), "guard personal ✓");
	});

	it("names the account and its zones on a No Match", () => {
		assert.equal(footerText(input({ config: config([{ ...acme, zones: ["work"] }]) })), "guard personal ✗ acme is work");
		assert.equal(footerText(input({ config: config([{ ...acme, zones: ["work", "lab"] }]) })), "guard personal ✗ acme is work, lab");
	});

	it("says untagged for an Unknown account", () => {
		assert.equal(footerText(input({ config: config([]) })), "guard personal ? untagged");
	});

	it("shows a session Override while it covers the current account", () => {
		const overrides = grantSession(NO_OVERRIDES, acme, personal);
		assert.equal(footerText(input({ config: config([{ ...acme, zones: ["work"] }]), overrides })), "guard OVERRIDE acme in personal");
		assert.equal(footerText(input({ config: config([]), overrides })), "guard OVERRIDE acme in personal");
	});

	it("shows the Match, not the Override, once the account matches", () => {
		assert.equal(footerText(input({ overrides: grantSession(NO_OVERRIDES, acme, personal) })), "guard personal ✓");
	});

	it("shows the real state when the session Override covers another account", () => {
		const overrides = grantSession(NO_OVERRIDES, beta, personal);
		assert.equal(footerText(input({ config: config([{ ...acme, zones: ["work"] }]), overrides })), "guard personal ✗ acme is work");
	});

	it("does not show allow-once, even beside a session Override", () => {
		const once = grantOnce(NO_OVERRIDES, acme, personal);
		assert.equal(footerText(input({ config: config([]), overrides: once })), "guard personal ? untagged");
		assert.equal(footerText(input({ config: config([]), overrides: grantSession(once, acme, personal) })), "guard OVERRIDE acme in personal");
	});

	it("says the config is invalid while the last valid copy decides", () => {
		assert.equal(footerText(input({ usingLastValid: true })), "guard ! config invalid (last valid copy in use)");
	});

	it("says turns are blocked when the config is invalid and no copy exists", () => {
		const place = { ok: false as const, reason: "the config is invalid" };
		assert.equal(footerText(input({ place, config: { ok: false, errors: [] } })), "guard ! config invalid, turns blocked");
	});

	it("says the zone is unknown when the place is undecidable", () => {
		assert.equal(footerText(input({ place: { ok: false, reason: "git failed" } })), "guard ! zone unknown (git failed)");
	});

	it("shows an Override over an invalid config, which never locks the user out", () => {
		const overrides = grantSession(NO_OVERRIDES, acme, personal);
		assert.equal(footerText(input({ config: { ok: false, errors: [] }, overrides })), "guard OVERRIDE acme in personal");
	});

	it("shows only the zone when no model is selected", () => {
		assert.equal(footerText(input({ account: undefined })), "guard personal ? no model");
	});
});
