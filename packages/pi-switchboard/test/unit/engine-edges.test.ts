import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawConfig } from "../../src/config/types.ts";
import { ExhaustedError } from "../../src/router/engine.ts";
import { answers, engine, input, RAW, user } from "../support/engine.ts";

const plan = async () => ({ stopReason: "stop" as const, answers: answers("plan") });

describe("engine: virtual ids and profile choice", () => {
	it("routes a profile id and a tier-pinned id, and ignores an unknown pinned tier", async () => {
		const { e } = engine({ classify: plan });
		assert.equal((await e.route(input({ virtualId: "main" }))).decision?.tier.chosen, "deep");
		const pinned = await e.route(input({ virtualId: "main.light" }));
		assert.deepEqual([pinned.id, pinned.decision?.kind], ["small", "pinned"]);
		assert.equal((await e.route(input({ virtualId: "main.ghost" }))).decision?.kind, "classified");
	});

	it("uses the session profile, then the global profile", async () => {
		const { e, deps } = engine();
		e.controls.profile = "other";
		assert.equal((await e.route(input())).decision?.profile.source, "manual-session");
		delete e.controls.profile;
		deps.globalProfile = () => "other";
		const global = await e.route(input());
		assert.deepEqual([global.decision?.profile.source, global.id], ["manual-global", "one"]);
	});

	it("passes the configured temperature to the classifier", async () => {
		const seen: Array<number | undefined> = [];
		const { e } = engine({
			raw: { ...RAW, classification: { temperature: 0.3 } },
			classify: async (_model, _request, options) => {
				seen.push(options.temperature);
				return { stopReason: "stop", answers: answers("implement") };
			},
		});
		await e.route(input());
		assert.deepEqual(seen, [0.3]);
	});

	it("records quota, cooldowns, failures and leases on the candidates", async () => {
		const { e, deps } = engine({
			deps: {
				quota: (member) =>
					member.provider === "zen"
						? { remaining: 0.5, resetsAt: Date.UTC(2026, 9, 25, 14), source: "pi-usage" }
						: { remaining: 0.9, source: "ledger" },
			},
		});
		const first = await e.route(input());
		e.beginRequest();
		await e.route(input({ reason: "retry", state: first.state, failed: { provider: "acme", id: "mid", errorMessage: "503 Service Unavailable" } }));
		const out = await e.route(input({ messages: [user("next")] }));
		const candidates = out.decision?.selection?.candidates ?? [];
		const zen = candidates.find((c) => c.member === "zen/mid:medium");
		assert.equal(zen?.quota?.resetsAt, "2026-10-25T14:00:00.000Z");
		assert.ok(
			candidates.some((c) => c.fails || c.cooldownUntil || c.inFlight),
			JSON.stringify(candidates),
		);
		assert.ok(deps.store.read());
	});
});

describe("engine: provider responses and failures", () => {
	it("ignores responses before any route and successful ones", async () => {
		const { e } = engine();
		e.noteResponse(429, { "retry-after": "60" });
		const first = await e.route(input());
		e.noteResponse(200, {});
		const out = await e.route(
			input({ reason: "retry", state: first.state, failed: { provider: "acme", id: "mid", errorMessage: "429 Too Many Requests" } }),
		);
		assert.equal(out.decision?.error?.class, "rate-limit");
	});

	it("uses the provider's retry header for the bench time", async () => {
		const { e } = engine();
		const first = await e.route(input());
		e.noteResponse(429, { "retry-after": "600" });
		const out = await e.route(input({ reason: "retry", state: first.state, failed: { provider: "acme", id: "mid", errorMessage: "slow down" } }));
		assert.equal(out.decision?.error?.benchedUntil, "2026-10-25T12:10:00.000Z");
		e.noteResponse(500, {});
		assert.equal(e.prepareFailover({ provider: "zen", id: "mid" }, "socket hang up").canFailOver, false, "only quota and auth errors are rewritten");
	});

	it("keeps the failed model when a retry has no state, and routes afresh without a failed model", async () => {
		const { e } = engine();
		const kept = await e.route(input({ reason: "retry", failed: { provider: "acme", id: "mid", thinking: "low" } }));
		assert.deepEqual([kept.provider, kept.id, kept.thinking, kept.decision], ["acme", "mid", "low", undefined]);
		assert.equal((await e.route(input({ reason: "retry" }))).decision?.reason, "user");
	});

	it("finds the failed model's tier when it is not the state's member", async () => {
		const { e } = engine();
		const first = await e.route(input());
		const out = await e.route(
			input({ reason: "retry", state: first.state, failed: { provider: "zen", id: "mid", errorMessage: "429 Too Many Requests" } }),
		);
		assert.equal(out.decision?.tier.chosen, "standard");
	});

	it("explains exhaustion with the earliest reset", () => {
		assert.match(
			new ExhaustedError({ member: "acme/mid", at: Date.UTC(2026, 9, 25, 13) }).message,
			/every model is cooling down; earliest reset .* on acme\/mid/,
		);
		assert.equal(new ExhaustedError().message, "pi-switchboard: every model is cooling down");
	});
});

describe("engine: continuation and direct requests", () => {
	it("routes a continuation without state as a new turn and without a previous model on its member", async () => {
		const { e } = engine();
		assert.equal((await e.route(input({ reason: "continuation" }))).decision?.reason, "user");
		const first = await e.route(input());
		const out = await e.route(input({ reason: "continuation", state: first.state }));
		assert.deepEqual([out.provider, out.id, out.thinking], ["acme", "mid", "medium"]);
		assert.equal(e.describeState(first.state), "acme/mid");
		assert.equal(e.describeState(undefined), undefined);
		const profile = e.deps.config.profiles.main;
		assert.ok(profile);
		assert.equal(e.rankOf(profile, "deep"), 3);
	});

	it("falls back to the previous model when no member fits a direct request, and throws without one", async () => {
		const { e } = engine();
		const huge = input({ reason: "direct", contextTokens: 10_000_000 });
		await assert.rejects(Promise.resolve(e.route(huge)), ExhaustedError);
		const out = await e.route({ ...huge, previous: { provider: "acme", id: "big" } });
		assert.deepEqual([out.provider, out.id, out.decision], ["acme", "big", undefined]);
	});

	it("answers a direct request from the origin model when inactive", async () => {
		const { e } = engine({ raw: { profiles: {} } as RawConfig });
		e.originModel = "acme/mid";
		const out = await e.route(input({ reason: "direct" }));
		assert.deepEqual([out.provider, out.id, out.decision?.kind, out.decision?.reason], ["acme", "mid", "inactive", "direct"]);
	});
});
