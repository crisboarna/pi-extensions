import type { RuleOutcome } from "../rules/evaluate.ts";
import { maxTier, minTier, rankOf, type RankedTier, resolveTarget, stepTier } from "../rules/targets.ts";

export type TierKind = "classified" | "fallback" | "pinned" | "dry-run" | "held" | "escalated" | "inactive";

export interface TierState {
	/** The tier the session is on, if a decision was made. */
	tier?: string;
	/** Consecutive confident decisions below the current tier. */
	downVotes: number;
}

export interface TierProfile {
	tiers: readonly RankedTier[];
	fallbackTier: string;
	baselineTier: string;
	hysteresis: { downTurns: number };
}

export interface UserTierInput {
	profile: TierProfile;
	state: TierState;
	/** Rule outcome; absent when no classifier answered. */
	outcome?: RuleOutcome;
	/** Why classification produced no outcome. */
	classifierFailure?: string;
	pin?: string;
	dryRun?: boolean;
}

export interface TierDecision {
	tier: string;
	kind: TierKind;
	why: string;
	/** The tier the rules (or the fallback) asked for, before hysteresis. */
	candidate: string;
	downVotes: number;
}

/**
 * The tier for a user turn in the main session (DESIGN.md 4.1):
 * a pin replaces everything; dry-run uses the baseline; an unconfident or
 * failed classification raises to the fallback tier but never lowers; a
 * confident decision raises at once and lowers only after `downTurns`
 * consecutive lower decisions.
 */
export function decideUserTier(input: UserTierInput): TierDecision {
	const { profile, state } = input;
	const tiers = profile.tiers;
	const previous = state.tier && tiers.some((tier) => tier.name === state.tier) ? state.tier : undefined;

	if (input.pin) {
		const pinned = resolveTarget(input.pin, tiers);
		if (pinned) return { tier: pinned, kind: "pinned", why: `pinned to ${input.pin}`, candidate: pinned, downVotes: 0 };
	}
	if (input.dryRun) {
		const tier = profile.baselineTier;
		return { tier, kind: "dry-run", why: "dry-run routes to the baseline tier", candidate: input.outcome?.tier ?? tier, downVotes: state.downVotes };
	}
	if (!input.outcome || input.outcome.fallback) {
		const candidate = input.outcome?.tier ?? profile.fallbackTier;
		const why = input.outcome ? `confidence ${input.outcome.gate.confidence.toFixed(2)} below ${input.outcome.gate.threshold}` : (input.classifierFailure ?? "no classifier answer");
		const tier = previous ? maxTier(previous, candidate, tiers) : candidate;
		const held = previous !== undefined && tier === previous && tier !== candidate;
		return { tier, kind: held ? "held" : "fallback", why: held ? `${why}; kept ${previous}, which is higher than the fallback` : why, candidate, downVotes: state.downVotes };
	}
	const candidate = input.outcome.tier;
	if (!previous || rankOf(candidate, tiers) >= rankOf(previous, tiers)) {
		const why = previous && candidate !== previous ? `raised from ${previous}` : `rule ${input.outcome.ruleIndex + 1}`;
		return { tier: candidate, kind: "classified", why, candidate, downVotes: 0 };
	}
	const downVotes = state.downVotes + 1;
	if (downVotes >= profile.hysteresis.downTurns) {
		return { tier: candidate, kind: "classified", why: `lowered from ${previous} after ${downVotes} lower turns`, candidate, downVotes: 0 };
	}
	return { tier: previous, kind: "held", why: `held ${previous}: ${downVotes} of ${profile.hysteresis.downTurns} lower turns`, candidate, downVotes };
}

export interface AgentLimits {
	minTier?: string;
	maxTier?: string;
	fixedTier?: string;
}

/**
 * The launch tier of a subagent task: the rules' tier, then the agent's fixed,
 * minimum and maximum tiers, then a `/tier pin --subagents`. No hysteresis.
 */
export function decideLaunchTier(profile: TierProfile, outcomeTier: string | undefined, limits: AgentLimits | undefined, pin: string | undefined): { tier: string; why: string } {
	const tiers = profile.tiers;
	if (pin) {
		const pinned = resolveTarget(pin, tiers);
		if (pinned) return { tier: pinned, why: `subagents pinned to ${pin}` };
	}
	const fixed = limits?.fixedTier ? resolveTarget(limits.fixedTier, tiers) : undefined;
	if (fixed) return { tier: fixed, why: `agent fixed to ${limits?.fixedTier}` };
	let tier = outcomeTier ?? profile.fallbackTier;
	const reasons: string[] = [];
	const floor = limits?.minTier ? resolveTarget(limits.minTier, tiers) : undefined;
	if (floor && rankOf(floor, tiers) > rankOf(tier, tiers)) {
		tier = floor;
		reasons.push(`raised to agent minimum ${limits?.minTier}`);
	}
	const ceiling = limits?.maxTier ? resolveTarget(limits.maxTier, tiers) : undefined;
	if (ceiling && rankOf(ceiling, tiers) < rankOf(tier, tiers)) {
		tier = minTier(tier, ceiling, tiers);
		reasons.push(`capped at agent maximum ${limits?.maxTier}`);
	}
	return { tier, why: reasons.join("; ") || "rules" };
}

/** One tool result since the last user message. */
export interface ToolOutcome {
	tool: string;
	isError: boolean;
}

export interface EscalationConfig {
	sameToolErrors: number;
	totalToolErrors: number;
	maxPerTask: number;
}

/** Why the task should escalate one rank, or undefined. Thresholds of 0 disable a trigger. */
export function escalationTrigger(outcomes: readonly ToolOutcome[], config: EscalationConfig): string | undefined {
	const errors = outcomes.filter((outcome) => outcome.isError);
	if (config.sameToolErrors > 0) {
		const counts = new Map<string, number>();
		for (const error of errors) counts.set(error.tool, (counts.get(error.tool) ?? 0) + 1);
		for (const [tool, count] of counts) if (count >= config.sameToolErrors) return `${tool} failed ${count} times`;
	}
	if (config.totalToolErrors > 0 && errors.length >= config.totalToolErrors) return `${errors.length} tool errors`;
	return undefined;
}

/** The tier after one escalation step, capped by `ceiling` when given. */
export function escalate(tier: string, tiers: readonly RankedTier[], ceiling?: string): string {
	const next = stepTier(tier, 1, tiers);
	return ceiling ? minTier(next, ceiling, tiers) : next;
}
