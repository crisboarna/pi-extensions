import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUILTIN_QUESTIONS } from "../../src/classifier/questions.ts";
import { BUILTIN_RULESET } from "../../src/rules/builtin.ts";
import { evaluateCondition, gatingConfidence } from "../../src/rules/conditions.ts";
import { evaluateRules } from "../../src/rules/evaluate.ts";
import { resolveTarget } from "../../src/rules/targets.ts";
import type { Answers, Ruleset } from "../../src/rules/types.ts";

const ladder = (...names: string[]) => names.map((name, rank) => ({ name, rank }));
const THREE = ladder("light", "standard", "deep");

interface FixtureCase {
	request: string;
	expected: "bottom" | "middle" | "top" | "middle+";
	answers: { work: { choice: string; confidence: number }; depth: { score: number; confidence: number }; risky: { probability: number } };
}
const fixture: { cases: FixtureCase[] } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "h2o-calibration.json"), "utf8"));

function toAnswers(c: FixtureCase): Answers {
	return {
		work: { type: "choice", choice: c.answers.work.choice, probabilities: {}, confidence: c.answers.work.confidence },
		depth: { type: "score", score: c.answers.depth.score, confidence: c.answers.depth.confidence },
		risky: { type: "bool", probability: c.answers.risky.probability },
	};
}

describe("tier targets", () => {
	it("resolves keywords for one, two, three and five tiers", () => {
		assert.deepEqual(
			["@bottom", "@middle", "@top"].map((t) => resolveTarget(t, ladder("only"))),
			["only", "only", "only"],
		);
		assert.deepEqual(
			["@bottom", "@middle", "@top"].map((t) => resolveTarget(t, ladder("a", "b"))),
			["a", "b", "b"],
		);
		assert.deepEqual(
			["@bottom", "@middle", "@top"].map((t) => resolveTarget(t, THREE)),
			["light", "standard", "deep"],
		);
		assert.equal(resolveTarget("@middle", ladder("a", "b", "c", "d", "e")), "c");
		assert.equal(resolveTarget("nope", THREE), undefined);
	});
});

describe("conditions", () => {
	const answers: Answers = {
		work: { type: "choice", choice: "plan", probabilities: {}, confidence: 0.9 },
		depth: { type: "score", score: 1.6, confidence: 0.3 },
		risky: { type: "bool", probability: 0.2 },
	};

	it("matches choices, score comparisons and labels, and bools", () => {
		const match = (when: Record<string, unknown>) => evaluateCondition(when as never, BUILTIN_QUESTIONS, answers, {}).matched;
		assert.ok(match({ work: "plan" }));
		assert.ok(match({ work: ["review", "plan"] }));
		assert.ok(match({ work: { not: "review" } }));
		assert.ok(match({ depth: ">=1.5" }) && !match({ depth: "<1.0" }));
		assert.ok(match({ depth: "deep" }), "1.6 rounds to level 2, labelled deep");
		assert.ok(match({ risky: false }) && match({ risky: "<0.3" }));
	});

	it("gates on choice and bool answers but never on scores", () => {
		const result = evaluateCondition({ work: "plan", depth: ">=1.5" }, BUILTIN_QUESTIONS, answers, {});
		assert.equal(result.confidence, 0.9, "depth confidence 0.3 does not gate");
		assert.ok(Math.abs((gatingConfidence({ type: "bool", probability: 0.95 }) ?? 0) - 0.9) < 1e-9, "bool uses |2p - 1|");
	});

	it("matches signals and treats missing answers as no match", () => {
		assert.ok(evaluateCondition({ $planMode: "planning" }, BUILTIN_QUESTIONS, {}, { $planMode: "planning" }).matched);
		assert.ok(!evaluateCondition({ work: "plan" }, BUILTIN_QUESTIONS, {}, {}).matched);
	});

	it("matches any alternative of a list", () => {
		assert.ok(evaluateCondition([{ work: "review" }, { depth: ">1" }], BUILTIN_QUESTIONS, answers, {}).matched);
	});
});

describe("evaluateRules", () => {
	const profile = { ruleset: BUILTIN_RULESET, tiers: THREE, fallbackTier: "standard" };

	it("falls back below the threshold", () => {
		const answers: Answers = { work: { type: "choice", choice: "plan", probabilities: {}, confidence: 0.6 } };
		const outcome = evaluateRules(profile, BUILTIN_QUESTIONS, answers, {}, 0.8);
		assert.equal(outcome.fallback, true);
		assert.equal(outcome.tier, "standard");
		assert.equal(outcome.ruleTier, "deep");
	});

	it("applies a confident floor on top of the rule tier", () => {
		const answers: Answers = {
			work: { type: "choice", choice: "mechanical", probabilities: {}, confidence: 0.95 },
			depth: { type: "score", score: 0.3, confidence: 0.2 },
			risky: { type: "bool", probability: 0.97 },
		};
		const outcome = evaluateRules(profile, BUILTIN_QUESTIONS, answers, {}, 0.8);
		assert.equal(outcome.ruleTier, "light");
		assert.equal(outcome.tier, "standard");
		assert.deepEqual(
			outcome.floors.map((f) => [f.applied, f.raised]),
			[[true, true]],
		);
	});

	it("uses the plan-mode signal before the classifier", () => {
		const outcome = evaluateRules(profile, BUILTIN_QUESTIONS, {}, { $planMode: "planning" }, 0.8);
		assert.equal(outcome.tier, "deep");
		assert.equal(outcome.gate.confidence, 1);
	});

	it("hits the default rule with no gate", () => {
		const outcome = evaluateRules(profile, BUILTIN_QUESTIONS, {}, {}, 0.99);
		assert.equal(outcome.tier, "standard");
		assert.equal(outcome.gate.passed, true);
	});

	it("works with named tiers in a custom ruleset", () => {
		const ruleset: Ruleset = { tierRules: [{ when: { work: "implement" }, tier: "builder" }, { tier: "@bottom" }] };
		const tiers = ladder("intern", "builder", "architect");
		const answers: Answers = { work: { type: "choice", choice: "implement", probabilities: {}, confidence: 0.9 } };
		assert.equal(evaluateRules({ ruleset, tiers, fallbackTier: "builder" }, BUILTIN_QUESTIONS, answers, {}, 0.8).tier, "builder");
	});
});

describe("calibration fixture (recorded H2O-Lightning-4B answers)", () => {
	const RANK: Record<string, number> = { light: 0, standard: 1, deep: 2 };
	const EXPECTED: Record<string, number> = { bottom: 0, middle: 1, top: 2, "middle+": 1 };
	const run = (threshold: number) =>
		fixture.cases.map((c) => {
			const tier = evaluateRules(
				{ ruleset: BUILTIN_RULESET, tiers: THREE, fallbackTier: "standard" },
				BUILTIN_QUESTIONS,
				toAnswers(c),
				{ $scope: "main" },
				threshold,
			).tier;
			const got = RANK[tier] ?? -1;
			const want = EXPECTED[c.expected] ?? -1;
			return { request: c.request, ok: c.expected === "middle+" ? got >= want : got === want, under: got < want };
		});

	it("puts at least 21 of 24 requests on the expected tier at threshold 0.80", () => {
		const results = run(0.8);
		const correct = results.filter((r) => r.ok).length;
		assert.ok(
			correct >= 21,
			`only ${correct}/24 correct: ${results
				.filter((r) => !r.ok)
				.map((r) => r.request)
				.join(" | ")}`,
		);
	});

	it("never puts a request below its expected tier at 0.80", () => {
		assert.deepEqual(
			run(0.8)
				.filter((r) => r.under)
				.map((r) => r.request),
			[],
		);
	});

	it("at 0.85, under-tiers only the debugging task the classifier calls review with 0.83", () => {
		assert.deepEqual(
			run(0.85)
				.filter((r) => r.under)
				.map((r) => r.request.slice(0, 31)),
			["debug this intermittent race co"],
		);
	});
});
