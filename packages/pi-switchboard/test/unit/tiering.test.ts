import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuleOutcome } from "../../src/rules/evaluate.ts";
import { decideLaunchTier, decideUserTier, escalate, escalationTrigger, type TierProfile } from "../../src/tiering/decide.ts";

const profile: TierProfile = {
	tiers: [
		{ name: "light", rank: 1 },
		{ name: "standard", rank: 2 },
		{ name: "deep", rank: 3 },
	],
	fallbackTier: "standard",
	baselineTier: "light",
	hysteresis: { downTurns: 2 },
};

const outcome = (tier: string, fallback = false): RuleOutcome => ({
	ruleIndex: 0,
	ruleTier: tier,
	gate: { referenced: ["work"], confidence: fallback ? 0.5 : 0.9, threshold: 0.8, passed: !fallback },
	floors: [],
	tier,
	fallback,
});

describe("decideUserTier", () => {
	it("raises at once and lowers only after downTurns lower turns", () => {
		let state = { downVotes: 0 } as { tier?: string; downVotes: number };
		const step = (tier: string) => {
			const decision = decideUserTier({ profile, state, outcome: outcome(tier) });
			state = { tier: decision.tier, downVotes: decision.downVotes };
			return decision;
		};
		assert.equal(step("standard").tier, "standard");
		assert.equal(step("deep").tier, "deep");
		const held = step("light");
		assert.equal(held.tier, "deep");
		assert.equal(held.kind, "held");
		assert.equal(step("light").tier, "light", "second lower turn lowers");
		assert.equal(state.downVotes, 0);
	});

	it("resets the down count when a turn is not lower", () => {
		const first = decideUserTier({ profile, state: { tier: "deep", downVotes: 0 }, outcome: outcome("light") });
		assert.equal(first.downVotes, 1);
		const again = decideUserTier({ profile, state: { tier: "deep", downVotes: 1 }, outcome: outcome("deep") });
		assert.equal(again.downVotes, 0);
	});

	it("never lowers on an unconfident or failed classification", () => {
		const unsure = decideUserTier({ profile, state: { tier: "deep", downVotes: 1 }, outcome: outcome("standard", true) });
		assert.equal(unsure.tier, "deep");
		assert.equal(unsure.kind, "held");
		assert.equal(unsure.downVotes, 1, "no down vote counted");
		const failed = decideUserTier({ profile, state: { tier: "light", downVotes: 0 }, classifierFailure: "timeout" });
		assert.equal(failed.tier, "standard", "raised to the fallback tier");
		assert.equal(failed.kind, "fallback");
	});

	it("honours pin and dry-run", () => {
		assert.equal(decideUserTier({ profile, state: { downVotes: 0 }, outcome: outcome("light"), pin: "@top" }).tier, "deep");
		const dry = decideUserTier({ profile, state: { downVotes: 0 }, outcome: outcome("deep"), dryRun: true });
		assert.equal(dry.tier, "light");
		assert.equal(dry.candidate, "deep");
	});
});

describe("decideLaunchTier", () => {
	it("applies fixed, minimum and maximum tiers and the subagent pin", () => {
		assert.equal(decideLaunchTier(profile, "deep", { maxTier: "standard" }, undefined).tier, "standard");
		assert.equal(decideLaunchTier(profile, "light", { minTier: "@middle" }, undefined).tier, "standard");
		assert.equal(decideLaunchTier(profile, "deep", { fixedTier: "light" }, undefined).tier, "light");
		assert.equal(decideLaunchTier(profile, "light", undefined, "@top").tier, "deep");
		assert.equal(decideLaunchTier(profile, undefined, undefined, undefined).tier, "standard");
	});
});

describe("escalation", () => {
	const config = { sameToolErrors: 2, totalToolErrors: 3, maxPerTask: 1 };

	it("fires on repeated failures of one tool or on many errors", () => {
		assert.equal(escalationTrigger([{ tool: "bash", isError: true }], config), undefined);
		assert.match(
			escalationTrigger(
				[
					{ tool: "bash", isError: true },
					{ tool: "read", isError: false },
					{ tool: "bash", isError: true },
				],
				config,
			) ?? "",
			/bash failed 2 times/u,
		);
		assert.match(
			escalationTrigger(
				[
					{ tool: "a", isError: true },
					{ tool: "b", isError: true },
					{ tool: "c", isError: true },
				],
				config,
			) ?? "",
			/3 tool errors/u,
		);
		assert.equal(
			escalationTrigger(
				[
					{ tool: "a", isError: true },
					{ tool: "a", isError: true },
				],
				{ ...config, sameToolErrors: 0 },
			),
			undefined,
		);
	});

	it("moves up one rank, capped by a ceiling", () => {
		assert.equal(escalate("light", profile.tiers), "standard");
		assert.equal(escalate("deep", profile.tiers), "deep");
		assert.equal(escalate("standard", profile.tiers, "standard"), "standard");
	});
});
