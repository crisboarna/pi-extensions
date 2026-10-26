import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_QUESTIONS } from "../../src/classifier/questions.ts";
import { evaluateCondition, matchSignal, matchValue, validateCondition, validateConditionValue } from "../../src/rules/conditions.ts";
import { evaluateRules } from "../../src/rules/evaluate.ts";
import { maxTier, minTier, rankOf, resolveTarget, stepTier } from "../../src/rules/targets.ts";
import type { Answer, Question, QuestionSet } from "../../src/rules/types.ts";

const choice = (value: string, confidence = 0.9): Answer => ({ type: "choice", choice: value, probabilities: { [value]: 0.95 }, confidence });
const score = (value: number): Answer => ({ type: "score", score: value, confidence: 0.9 });
const bool = (probability: number): Answer => ({ type: "bool", probability });
const work = BUILTIN_QUESTIONS.work as Question;
const depth = BUILTIN_QUESTIONS.depth as Question;
const risky = BUILTIN_QUESTIONS.risky as Question;
const unlabelled: QuestionSet = { level: { type: "score", instructions: "How deep?", criteria: ["low", "high"] } };

describe("validateConditionValue", () => {
	it("checks signal values are strings or string lists", () => {
		assert.equal(validateConditionValue("$scope", "main", BUILTIN_QUESTIONS), undefined);
		assert.equal(validateConditionValue("$agent", ["scout", "worker"], BUILTIN_QUESTIONS), undefined);
		assert.match(validateConditionValue("$agent", ["scout", 3] as never, BUILTIN_QUESTIONS) ?? "", /must be a string or a list of strings/);
	});

	it("checks choice values, including { not }", () => {
		assert.equal(validateConditionValue("work", { not: ["plan"] }, BUILTIN_QUESTIONS), undefined);
		assert.match(validateConditionValue("work", 3, BUILTIN_QUESTIONS) ?? "", /expects a label, a list of labels or \{ not \}/);
		assert.match(validateConditionValue("work", { not: 3 } as never, BUILTIN_QUESTIONS) ?? "", /expects a label/);
	});

	it("checks score values: integer levels, comparisons and labels", () => {
		assert.equal(validateConditionValue("depth", 2, BUILTIN_QUESTIONS), undefined);
		assert.match(validateConditionValue("depth", 1.5, BUILTIN_QUESTIONS) ?? "", /level must be an integer/);
		assert.equal(validateConditionValue("depth", "deep", BUILTIN_QUESTIONS), undefined);
		assert.match(validateConditionValue("depth", true, BUILTIN_QUESTIONS) ?? "", /shallow, moderate, deep/);
		assert.match(validateConditionValue("level", "huge", unlabelled) ?? "", /its level numbers/);
	});

	it("checks bool values: booleans and comparisons", () => {
		assert.equal(validateConditionValue("risky", ">0.7", BUILTIN_QUESTIONS), undefined);
		assert.match(validateConditionValue("risky", "maybe", BUILTIN_QUESTIONS) ?? "", /expects true, false or a comparison/);
		assert.match(validateConditionValue("risky", 1, BUILTIN_QUESTIONS) ?? "", /expects true, false or a comparison/);
	});
});

describe("validateCondition", () => {
	it("rejects an empty list and parts that are not objects", () => {
		assert.deepEqual(validateCondition([], BUILTIN_QUESTIONS), ["an empty condition list never matches"]);
		assert.deepEqual(validateCondition([null as never, "x" as never], BUILTIN_QUESTIONS), [
			"each condition must be an object",
			"each condition must be an object",
		]);
		assert.deepEqual(validateCondition({ work: "plan" }, BUILTIN_QUESTIONS), []);
	});
});

describe("matchValue", () => {
	it("never matches without a question, an answer, or with mismatched types", () => {
		assert.equal(matchValue(undefined, choice("plan"), "plan"), false);
		assert.equal(matchValue(work, undefined, "plan"), false);
		assert.equal(matchValue(work, score(1), "plan"), false);
	});

	it("matches choices by label, list and { not }", () => {
		assert.equal(matchValue(work, choice("plan"), ["plan", "review"]), true);
		assert.equal(matchValue(work, choice("plan"), { not: "plan" }), false);
		assert.equal(matchValue(work, choice("plan"), 3), false);
	});

	it("matches scores by level, comparison and label", () => {
		assert.equal(matchValue(depth, score(1.6), 2), true);
		assert.equal(matchValue(depth, score(1.6), true), false);
		assert.equal(matchValue(depth, score(0.4), "<=0.5"), true);
		assert.equal(matchValue(depth, score(1), "==1"), true);
		assert.equal(matchValue(depth, score(2.2), "deep"), true);
		assert.equal(matchValue(depth, score(2.2), "abyssal"), false);
		assert.equal(matchValue(unlabelled.level, score(1), "high"), false);
	});

	it("matches bools by value and comparison", () => {
		assert.equal(matchValue(risky, bool(0.8), true), true);
		assert.equal(matchValue(risky, bool(0.8), "<0.5"), false);
		assert.equal(matchValue(risky, bool(0.8), "maybe"), false);
		assert.equal(matchValue(risky, bool(0.8), 1), false);
	});
});

describe("signals", () => {
	it("match strings and lists, and never non-signal keys or unset signals", () => {
		assert.equal(matchSignal({ $agent: "scout" }, "$agent", ["scout", "worker"]), true);
		assert.equal(matchSignal({ $agent: "scout" }, "$agent", 3), false);
		assert.equal(matchSignal({ $agent: "scout" }, "work", "scout"), false);
		assert.equal(matchSignal({}, "$agent", "scout"), false);
	});

	it("gate a condition alongside answers", () => {
		const match = evaluateCondition(
			[{ $scope: "subagent" }, { work: "plan", depth: ">=1" }],
			BUILTIN_QUESTIONS,
			{ work: choice("plan", 0.7), depth: score(1.2) },
			{},
		);
		assert.deepEqual(match, { matched: true, referenced: ["work", "depth"], confidence: 0.7 });
		assert.deepEqual(evaluateCondition({ work: "review" }, BUILTIN_QUESTIONS, {}, {}), { matched: false, referenced: [], confidence: 0 });
	});
});

describe("targets", () => {
	const tiers = [
		{ name: "low", rank: 1 },
		{ name: "mid", rank: 2 },
		{ name: "high", rank: 3 },
	];
	it("resolves names and rank keywords, and nothing without tiers", () => {
		assert.equal(resolveTarget("@top", []), undefined);
		assert.equal(resolveTarget("@bottom", tiers), "low");
		assert.equal(resolveTarget("ghost", tiers), undefined);
	});

	it("ranks, steps and compares tiers, including unknown ones", () => {
		assert.equal(rankOf("ghost", tiers), Number.NEGATIVE_INFINITY);
		assert.equal(stepTier("ghost", 1, tiers), "ghost");
		assert.equal(stepTier("high", 1, tiers), "high");
		assert.equal(stepTier("low", -1, tiers), "low");
		assert.equal(maxTier("low", "mid", tiers), "mid");
		assert.equal(minTier("high", "mid", tiers), "mid");
		assert.equal(minTier("low", "mid", tiers), "low");
	});
});

describe("evaluateRules", () => {
	const tiers = [
		{ name: "low", rank: 1 },
		{ name: "high", rank: 2 },
	];
	it("uses the fallback tier for unknown targets and skips floors that name no tier", () => {
		const outcome = evaluateRules(
			{
				ruleset: {
					tierRules: [{ when: { work: "plan" }, tier: "ghost" }, { tier: "ghost" }],
					floorRules: [{ when: { risky: true }, atLeast: "nowhere" }],
				},
				tiers,
				fallbackTier: "high",
			},
			BUILTIN_QUESTIONS,
			{ work: choice("review") },
			{},
			0.5,
		);
		assert.deepEqual([outcome.tier, outcome.ruleIndex, outcome.floors], ["high", 1, []]);
		const matched = evaluateRules(
			{ ruleset: { tierRules: [{ when: { work: "plan" }, tier: "ghost" }, { tier: "low" }] }, tiers, fallbackTier: "high" },
			BUILTIN_QUESTIONS,
			{ work: choice("plan") },
			{},
			0.5,
		);
		assert.deepEqual([matched.tier, matched.ruleIndex], ["high", 0]);
	});
});
