import type { Answer } from "../rules/types.ts";

export const DECISION_TYPE = "pi-switchboard.decision";
export const LINK_TYPE = "pi-switchboard.link";
export const CONTROL_TYPE = "pi-switchboard.control";
export const PROFILE_TYPE = "pi-switchboard.profile";

export type ProfileSource = "model" | "manual-session" | "manual-global" | "project" | "match" | "default";

export type DecisionKind =
	| "classified"
	| "fallback"
	| "pinned"
	| "dry-run"
	| "held"
	| "escalated"
	| "failover"
	| "borrowed"
	| "direct"
	| "launch-tier"
	| "inactive";

export interface CandidateRecord {
	member: string;
	eligible: boolean;
	excluded?: string;
	cooldownUntil?: string;
	fails?: number;
	inFlight?: number;
	quota?: { remaining: number; resetsAt?: string; source: string };
}

/** One routing decision, appended as a session custom entry (never in LLM context). */
export interface DecisionEntry {
	v: 1;
	id: string;
	/** ISO-8601 UTC. */
	ts: string;
	task: number;
	scope: "main" | "subagent";
	reason: "user" | "continuation" | "retry" | "direct" | "launch";
	kind: DecisionKind;
	profile: { name: string; source: ProfileSource };
	/** `state` is the redacted classifier input, kept so replay can re-run the classifier. */
	evidence?: { digest: string; excerpt: string; tokens: number; truncated: boolean; state?: Record<string, unknown> };
	classifier?: {
		model?: string;
		latencyMs: number;
		attempts: Array<{ model: string; ok: boolean; error?: string; latencyMs: number; cold?: boolean }>;
		usage?: { input: number; output: number; cost: number };
		failure?: string;
	};
	answers?: Record<string, Answer>;
	rules?: {
		ruleset: string;
		matched: number;
		gate: { referenced: string[]; confidence: number; threshold: number; passed: boolean };
		floors: Array<{ index: number; atLeast: string; confidence: number; applied: boolean; raised: boolean }>;
	};
	tier: { candidate: string; chosen: string; previous?: string; rank: number; why: string; downVotes?: number; borrowedFrom?: string };
	selection?: {
		strategy: string;
		granularity: string;
		why: string;
		metricFallback?: string;
		kept: boolean;
		shared: boolean;
		candidates: CandidateRecord[];
	};
	model: { provider: string; id: string; thinking: string; contextWindow?: number; account?: string; subscription?: boolean };
	switch: { from?: string; cacheMiss: boolean };
	error?: { class: string; message: string; benchedUntil?: string };
	subagent?: { agent: string; taskIndex: number; toolCallId: string; mode: "child" | "launch" | "skipped"; skipped?: string; launchTier?: string; maxTier?: string };
	budget?: Array<{ scope: "task" | "session"; metric: "tokens" | "costUsd"; used: number; limit: number }>;
	dryRun?: boolean;
	/** The virtual model that was selected (provider/id). */
	virtualModel?: string;
}

/** Joins launch decisions to child runs once the run id exists. */
export interface LinkEntry {
	v: 1;
	toolCallId: string;
	links: Array<{ decisionId: string; taskIndex: number; runId?: string; sessionFile?: string; model?: string }>;
}

/** Command-set controls, restored at session start. */
export interface ControlEntry {
	v: 1;
	pin?: { target: string; subagents: boolean } | null;
	dryRun?: boolean;
	profile?: string | null;
}

/** Snapshot of the active profile, so the inspector can price counterfactuals offline. */
export interface ProfileSnapshotEntry {
	v: 1;
	profile: string;
	tiers: Array<{ name: string; rank: number; members: Array<{ key: string; price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }> }>;
	baselineTier: string;
	topTier: string;
}
