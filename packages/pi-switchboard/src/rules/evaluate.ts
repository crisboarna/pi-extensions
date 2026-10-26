import { evaluateCondition } from "./conditions.ts";
import { maxTier, type RankedTier, rankOf, resolveTarget } from "./targets.ts";
import type { Answers, QuestionSet, Ruleset, Signals } from "./types.ts";

export interface FloorOutcome {
	index: number;
	atLeast: string;
	confidence: number;
	/** The floor matched and its confidence passed the threshold. */
	applied: boolean;
	/** The floor changed the tier. */
	raised: boolean;
}

export interface RuleOutcome {
	/** Index of the matched tier rule. */
	ruleIndex: number;
	/** The tier the matched rule points at. */
	ruleTier: string;
	gate: { referenced: string[]; confidence: number; threshold: number; passed: boolean };
	floors: FloorOutcome[];
	/** The tier after gating and floors. */
	tier: string;
	/** The gate failed, so the fallback tier was used. */
	fallback: boolean;
}

export interface RuleProfile {
	ruleset: Ruleset;
	/** Sorted by rank, lowest first. */
	tiers: readonly RankedTier[];
	fallbackTier: string;
}

/**
 * Runs the tier rules (first match wins) and the floor rules (every match
 * applies) against classifier answers and signals. A tier rule whose gating
 * confidence is below `threshold` yields the fallback tier.
 */
export function evaluateRules(profile: RuleProfile, questions: QuestionSet, answers: Answers, signals: Signals, threshold: number): RuleOutcome {
	const { tiers } = profile;
	let ruleIndex = profile.ruleset.tierRules.length - 1;
	let ruleTier = profile.fallbackTier;
	let gate = { referenced: [] as string[], confidence: 1, threshold, passed: true };
	for (const [index, rule] of profile.ruleset.tierRules.entries()) {
		if (rule.when === undefined) {
			ruleIndex = index;
			ruleTier = resolveTarget(rule.tier, tiers) ?? profile.fallbackTier;
			break;
		}
		const match = evaluateCondition(rule.when, questions, answers, signals);
		if (!match.matched) continue;
		ruleIndex = index;
		ruleTier = resolveTarget(rule.tier, tiers) ?? profile.fallbackTier;
		gate = { referenced: match.referenced, confidence: match.confidence, threshold, passed: match.confidence >= threshold };
		break;
	}
	let tier = gate.passed ? ruleTier : profile.fallbackTier;
	const floors: FloorOutcome[] = [];
	for (const [index, rule] of (profile.ruleset.floorRules ?? []).entries()) {
		const atLeast = resolveTarget(rule.atLeast, tiers);
		if (!atLeast) continue;
		const match = evaluateCondition(rule.when, questions, answers, signals);
		const applied = match.matched && match.confidence >= threshold;
		const raised = applied && rankOf(atLeast, tiers) > rankOf(tier, tiers);
		if (raised) tier = maxTier(tier, atLeast, tiers);
		floors.push({ index, atLeast, confidence: match.matched ? match.confidence : 0, applied, raised });
	}
	return { ruleIndex, ruleTier, gate, floors, tier, fallback: !gate.passed };
}
