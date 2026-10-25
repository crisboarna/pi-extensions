import type { Ruleset } from "./types.ts";

/**
 * The built-in ruleset (ADR-0003). It targets rank keywords so it works with
 * any profile, and its depth thresholds come from recorded classifier answers
 * (DESIGN.md 8.5): scores are judged by value, never by their confidence.
 */
export const BUILTIN_RULESET: Ruleset = {
	tierRules: [
		{ when: { $planMode: "planning" }, tier: "@top" },
		{ when: { work: ["plan", "review"] }, tier: "@top" },
		{ when: { depth: ">=1.5" }, tier: "@top" },
		{ when: { work: ["mechanical", "research"], depth: "<1.0" }, tier: "@bottom" },
		{ tier: "@middle" },
	],
	floorRules: [{ when: { risky: true }, atLeast: "@middle" }],
};

export const BUILTIN_RULESET_NAME = "builtin";
