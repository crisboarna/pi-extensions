import type { QuestionSet, Ruleset } from "../rules/types.ts";
import type { ThinkingLevel } from "../util/model-ref.ts";

export const STRATEGY_NAMES = [
	"ordered",
	"sticky",
	"round-robin",
	"weighted",
	"random",
	"least-recently-used",
	"least-in-flight",
	"quota-headroom",
	"soonest-reset",
	"cheapest",
	"largest-context",
	"fastest",
	"subscription-preferred",
	"scheduled",
	"custom",
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];
export type Granularity = "session" | "task" | "request";

// ---------------------------------------------------------------------------
// Raw config: what users write in pi-switchboard.json
// ---------------------------------------------------------------------------

export interface ScheduleWindow {
	/** `mon-fri`, `sat,sun`, `daily`. */
	days?: string;
	/** `HH:MM`, local time. */
	from: string;
	to: string;
}

export interface MemberBudget {
	/** Window length: `5h`, `1d`, `7d`. */
	window: string;
	tokens?: number;
	costUsd?: number;
}

export interface MemberConfig {
	model: string;
	thinking?: ThinkingLevel;
	weight?: number;
	enabled?: boolean;
	maxConcurrency?: number;
	schedule?: ScheduleWindow[];
	budget?: MemberBudget;
	tags?: string[];
}

export type MemberInput = string | MemberConfig;

export interface StrategyConfig {
	name: StrategyName;
	granularity?: Granularity;
	/** Strategy used when this one's metric is missing. */
	fallback?: StrategyName;
	/** `custom` only: absolute or `~/` path to a module exporting `select`. */
	module?: string;
}

export interface TierConfig {
	rank: number;
	members: MemberInput[];
	strategy?: StrategyName | StrategyConfig;
	affinity?: { scope: "session" | "task"; ttlMs?: number | null };
	cooldown?: { scope?: "member" | "provider-model-account"; defaultMs?: number };
}

export interface BudgetLimits {
	tokens?: number;
	costUsd?: number;
}

export interface Budgets {
	task?: BudgetLimits;
	session?: BudgetLimits;
}

export interface ProfileConfig {
	description?: string;
	projects?: string[];
	ruleset?: string | Ruleset;
	threshold?: number;
	strategy?: StrategyName | StrategyConfig;
	tiers: Record<string, TierConfig>;
	fallbackTier?: string;
	baselineTier?: string;
	directTier?: string;
	hysteresis?: { downTurns?: number };
	escalation?: { sameToolErrors?: number; totalToolErrors?: number; maxPerTask?: number };
	budgets?: Budgets;
}

export interface ClassifierProviderConfig {
	name: string;
	baseUrl: string;
	api?: "system-one";
	models: string[];
	apiKey?: string;
}

export interface ClassifierEntry {
	model: string;
	timeoutMs?: number;
	threshold?: number;
	allowRemote?: boolean;
	warmup?: boolean;
	keepWarmMs?: number | null;
}

export interface ProfileSelectionRule {
	matchProvider?: string;
	matchModel?: string;
	profile: string;
}

export interface AgentTierLimits {
	minTier?: string;
	maxTier?: string;
	fixedTier?: string;
}

export interface RawConfig {
	$schema?: string;
	version?: number;
	virtualModel?: { provider?: string; id?: string; name?: string };
	classifierProviders?: ClassifierProviderConfig[];
	classifiers?: ClassifierEntry[];
	classification?: {
		threshold?: number;
		decisionBudgetMs?: number;
		temperature?: number | null;
		questions?: "builtin" | QuestionSet;
		evidence?: {
			maxTokens?: number;
			requestTokens?: number;
			toolErrors?: { max?: number; chars?: number };
			redact?: string[];
		};
	};
	rulesets?: Record<string, Ruleset>;
	profiles?: Record<string, ProfileConfig>;
	/** Project files only: the profile this project uses. */
	profile?: string;
	profileSelection?: { default?: string; rules?: ProfileSelectionRule[] };
	subagents?: {
		enabled?: boolean;
		mode?: "auto" | "child" | "launch";
		profile?: string | null;
		accountAffinity?: "parent" | "none";
		exclude?: string[];
		agents?: Record<string, AgentTierLimits>;
	};
	failover?: {
		accountSiblings?: "off" | "on";
		overloadSwitchAfter?: number;
		errorClasses?: Record<string, string[]>;
	};
	metrics?: { piUsage?: "auto" | "off"; ledger?: { retainDays?: number } };
	budgets?: Budgets;
	exhaustion?: { borrow?: Array<"up" | "down">; autoContinue?: boolean; maxWaitMs?: number };
	autoTier?: { nameHints?: { small?: string[]; large?: string[] } };
	live?: { mirror?: boolean; toolResultBytes?: number; retainHours?: number };
	state?: { shared?: boolean };
	ui?: {
		navigator?: { shortcut?: string; refreshMs?: number; widget?: "auto" | "off" };
		status?: string;
		statusSub?: string;
		entries?: "collapsed" | "expanded";
	};
	debug?: { log?: boolean; fullEvidence?: boolean; maxBytes?: number; maxFiles?: number };
}

// ---------------------------------------------------------------------------
// Normalized config: what the engine uses
// ---------------------------------------------------------------------------

export interface Member {
	/** `provider/id` or `provider/id:thinking`; unique within a tier. */
	key: string;
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
	weight: number;
	enabled: boolean;
	/** Why the member was disabled, when it was. */
	disabledReason?: string;
	maxConcurrency?: number;
	schedule?: ScheduleWindow[];
	budget?: MemberBudget;
	tags: string[];
	/** Position in the configured list; ties break on it. */
	index: number;
}

export interface StrategySpec {
	name: StrategyName;
	granularity: Granularity;
	fallback: StrategyName;
	module?: string;
}

export interface Tier {
	name: string;
	rank: number;
	members: Member[];
	strategy: StrategySpec;
	affinity?: { scope: "session" | "task"; ttlMs?: number | null };
	cooldown: { scope: "member" | "provider-model-account"; defaultMs?: number };
}

export interface Profile {
	name: string;
	description?: string;
	projects: string[];
	/** Sorted by rank, lowest first. */
	tiers: Tier[];
	ruleset: Ruleset;
	rulesetName: string;
	threshold?: number;
	fallbackTier: string;
	baselineTier: string;
	directTier: string;
	hysteresis: { downTurns: number };
	escalation: { sameToolErrors: number; totalToolErrors: number; maxPerTask: number };
	budgets?: Budgets;
}

export interface Config {
	version: 1;
	virtualModel: { provider: string; id: string; name: string };
	classifierProviders: ClassifierProviderConfig[];
	classifiers: Array<Required<Pick<ClassifierEntry, "model" | "timeoutMs">> & ClassifierEntry>;
	classification: {
		threshold: number;
		decisionBudgetMs: number;
		temperature?: number;
		questions: QuestionSet;
		evidence: { maxTokens: number; requestTokens: number; toolErrors: { max: number; chars: number }; redact: string[] };
	};
	profiles: Record<string, Profile>;
	/** Profiles that failed validation, with the reasons. */
	invalidProfiles: Record<string, string[]>;
	projectProfile?: string;
	profileSelection: { default?: string; rules: ProfileSelectionRule[] };
	subagents: {
		enabled: boolean;
		mode: "auto" | "child" | "launch";
		profile?: string;
		accountAffinity: "parent" | "none";
		exclude: string[];
		agents: Record<string, AgentTierLimits>;
	};
	failover: { accountSiblings: "off" | "on"; overloadSwitchAfter: number; errorClasses: Record<string, string[]> };
	metrics: { piUsage: "auto" | "off"; ledgerRetainDays: number };
	budgets?: Budgets;
	exhaustion: { borrow: Array<"up" | "down">; autoContinue: boolean; maxWaitMs: number };
	autoTier: { nameHints: { small: string[]; large: string[] } };
	live: { mirror: boolean; toolResultBytes: number; retainHours: number };
	state: { shared: boolean };
	ui: {
		navigator: { shortcut: string; refreshMs: number; widget: "auto" | "off" };
		status: string;
		statusSub: string;
		entries: "collapsed" | "expanded";
	};
	debug: { log: boolean; fullEvidence: boolean; maxBytes: number; maxFiles: number };
	warnings: string[];
	/** Files the config came from. */
	sources: string[];
}

/** What validation needs to know about pi's catalog; implemented over ctx.modelRegistry. */
export interface CatalogView {
	/** Context window and prices of a chat model, if the catalog has it. */
	find(provider: string, id: string): { contextWindow?: number } | undefined;
	hasAuth(provider: string): boolean;
	isProvider(name: string): boolean;
}
