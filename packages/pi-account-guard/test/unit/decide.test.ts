import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, type DecideInput } from "../../src/core/decide.ts";
import { DEFAULT_CONFIG, type GuardConfig } from "../../src/core/config.ts";

const config = (overrides: Partial<GuardConfig> = {}): GuardConfig => ({ ...DEFAULT_CONFIG, ...overrides });
const account = { provider: "acme", source: "oauth" };
const place = { ok: true as const, path: "/srv/app", zone: "personal" };

const input = (overrides: Partial<DecideInput> = {}): DecideInput => ({
	place,
	account,
	config: { ok: true, config: config({ accounts: [{ provider: "acme", source: "oauth", zones: ["personal"] }] }) },
	...overrides,
});

describe("decide", () => {
	it("matches when the place zone is one of the account zones", () => {
		assert.deepEqual(decide(input()), { verdict: "match" });
		const multi = config({ accounts: [{ provider: "acme", source: "oauth", zones: ["work", "personal"] }] });
		assert.deepEqual(decide(input({ config: { ok: true, config: multi } })), { verdict: "match" });
	});

	it("blocks a tagged account whose zones miss the place zone", () => {
		const tagged = config({ accounts: [{ provider: "acme", source: "oauth", zones: ["work"] }] });
		assert.deepEqual(decide(input({ config: { ok: true, config: tagged } })), {
			verdict: "block",
			cause: { kind: "zone-mismatch", account, accountZones: ["work"], place },
		});
	});

	it("blocks an untagged account, which is in the Unknown zone", () => {
		assert.deepEqual(decide(input({ config: { ok: true, config: config() } })), { verdict: "block", cause: { kind: "unknown-account", account, place } });
	});

	it("blocks the same provider on another auth source as an untagged account", () => {
		const other = { provider: "acme", source: "stored-key" };
		const decision = decide(input({ account: other }));
		assert.equal(decision.verdict === "block" && decision.cause.kind, "unknown-account");
	});

	it("blocks every turn when the config is invalid, naming the errors", () => {
		const errors = [{ path: "accounts[0]", message: "bad" }];
		assert.deepEqual(decide(input({ config: { ok: false, errors } })), { verdict: "block", cause: { kind: "config-invalid", account, errors } });
	});

	it("blocks when the place zone could not be resolved", () => {
		assert.deepEqual(decide(input({ place: { ok: false, reason: "cannot resolve /srv/app" } })), {
			verdict: "block",
			cause: { kind: "place-undecidable", account, reason: "cannot resolve /srv/app" },
		});
	});
});
