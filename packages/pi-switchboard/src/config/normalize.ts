import { BUILTIN_QUESTIONS } from "../classifier/questions.ts";
import { BUILTIN_RULESET, BUILTIN_RULESET_NAME } from "../rules/builtin.ts";
import { validateCondition } from "../rules/conditions.ts";
import { resolveTarget } from "../rules/targets.ts";
import type { QuestionSet, Ruleset } from "../rules/types.ts";
import { isRankKeyword } from "../rules/types.ts";
import { formatModelRef, isThinkingLevel, parseModelRef, splitAccountProvider } from "../util/model-ref.ts";
import type {
	CatalogView,
	Config,
	Member,
	MemberInput,
	Profile,
	ProfileConfig,
	RawConfig,
	StrategyConfig,
	StrategyName,
	StrategySpec,
	Tier,
	TierConfig,
} from "./types.ts";
import { STRATEGY_NAMES } from "./types.ts";

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

const DEFAULTS = {
	threshold: 0.85,
	decisionBudgetMs: 4000,
	classifierTimeoutMs: 2000,
	evidence: { maxTokens: 4000, requestTokens: 2500, toolErrors: { max: 5, chars: 200 } },
	downTurns: 2,
	escalation: { sameToolErrors: 2, totalToolErrors: 3, maxPerTask: 1 },
	cooldownMs: 5 * 60_000,
	overloadSwitchAfter: 2,
	ledgerRetainDays: 30,
	maxWaitMs: 6 * 60 * 60_000,
	toolResultBytes: 4096,
	retainHours: 24,
	refreshMs: 500,
	shortcut: "ctrl+alt+w",
	status: "{profile} · {tier} · {member} · {confidence}",
	statusSub: "{routed} subagents routed",
	debugMaxBytes: 5 * 1024 * 1024,
	debugMaxFiles: 3,
} as const;

/** Context windows in one tier more than this far apart get a warning. */
const CONTEXT_SPREAD_WARNING = 4;

export interface NormalizeOptions {
	catalog?: CatalogView;
	sources?: string[];
	/** Warnings collected while loading files, carried into the result. */
	warnings?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuestions(raw: RawConfig, warnings: string[]): QuestionSet {
	const custom = raw.classification?.questions;
	if (custom === undefined || custom === "builtin") return BUILTIN_QUESTIONS;
	if (!isObject(custom) || Object.keys(custom).length === 0) {
		warnings.push('classification.questions must be "builtin" or a non-empty map; using the built-in questions');
		return BUILTIN_QUESTIONS;
	}
	return custom;
}

function normalizeStrategy(input: StrategyName | StrategyConfig | undefined, inherited: StrategySpec | undefined, errors: string[], where: string): StrategySpec {
	if (input === undefined) return inherited ?? { name: "sticky", granularity: "session", fallback: "ordered" };
	const config: StrategyConfig = typeof input === "string" ? { name: input } : input;
	if (!STRATEGY_NAMES.includes(config.name)) {
		errors.push(`${where}: unknown strategy "${config.name}"`);
		return { name: "ordered", granularity: "session", fallback: "ordered" };
	}
	if (config.fallback && (!STRATEGY_NAMES.includes(config.fallback) || config.fallback === "custom")) {
		errors.push(`${where}: fallback strategy "${config.fallback}" is not allowed`);
	}
	if (config.name === "custom" && !config.module) errors.push(`${where}: the custom strategy needs a module path`);
	const spec: StrategySpec = { name: config.name, granularity: config.granularity ?? "session", fallback: config.fallback ?? "ordered" };
	if (config.module) spec.module = config.module;
	return spec;
}

function normalizeMember(input: MemberInput, index: number, errors: string[], where: string): Member | undefined {
	const config = typeof input === "string" ? { model: input } : input;
	if (!isObject(config) || typeof config.model !== "string") {
		errors.push(`${where}: member ${index + 1} needs a "model" string`);
		return undefined;
	}
	const ref = parseModelRef(config.model);
	if (!ref) {
		errors.push(`${where}: "${config.model}" is not a provider/model reference`);
		return undefined;
	}
	if (config.thinking !== undefined && !isThinkingLevel(config.thinking)) {
		errors.push(`${where}: "${config.thinking}" is not a thinking level`);
	}
	const thinking = config.thinking ?? ref.thinking;
	const member: Member = {
		key: formatModelRef({ provider: ref.provider, id: ref.id, ...(thinking ? { thinking } : {}) }),
		provider: ref.provider,
		id: ref.id,
		weight: typeof config.weight === "number" && config.weight > 0 ? config.weight : 1,
		enabled: config.enabled !== false,
		tags: Array.isArray(config.tags) ? config.tags : [],
		index,
	};
	if (thinking) member.thinking = thinking;
	if (config.enabled === false) member.disabledReason = "disabled in config";
	if (typeof config.maxConcurrency === "number") member.maxConcurrency = config.maxConcurrency;
	if (config.schedule) member.schedule = config.schedule;
	if (config.budget) member.budget = config.budget;
	return member;
}

function checkCatalog(member: Member, catalog: CatalogView | undefined): void {
	if (!catalog || !member.enabled) return;
	if (!catalog.find(member.provider, member.id)) {
		member.enabled = false;
		member.disabledReason = "not in the model catalog";
	} else if (!catalog.hasAuth(member.provider)) {
		member.enabled = false;
		member.disabledReason = "provider has no credentials";
	}
}

function normalizeTier(
	name: string,
	raw: TierConfig,
	profileStrategy: StrategySpec | undefined,
	catalog: CatalogView | undefined,
	errors: string[],
	warnings: string[],
	where: string,
): Tier | undefined {
	const at = `${where} tier "${name}"`;
	if (!NAME_PATTERN.test(name)) errors.push(`${at}: tier names use lowercase letters, digits and dashes`);
	if (!isObject(raw)) {
		errors.push(`${at}: must be an object`);
		return undefined;
	}
	if (!Number.isInteger(raw.rank)) errors.push(`${at}: rank must be an integer`);
	if (!Array.isArray(raw.members) || raw.members.length === 0) {
		errors.push(`${at}: needs at least one member`);
		return undefined;
	}
	const members: Member[] = [];
	const seen = new Set<string>();
	raw.members.forEach((input, index) => {
		const member = normalizeMember(input, index, errors, at);
		if (!member) return;
		if (seen.has(member.key)) {
			errors.push(`${at}: member "${member.key}" is listed twice`);
			return;
		}
		seen.add(member.key);
		checkCatalog(member, catalog);
		members.push(member);
	});
	const usable = members.filter((member) => member.enabled);
	if (members.length > 0 && usable.length === 0) {
		errors.push(`${at}: no usable member (${members.map((m) => `${m.key}: ${m.disabledReason}`).join("; ")})`);
	}
	for (const member of members) {
		if (!member.enabled && member.disabledReason !== "disabled in config" && usable.length > 0) {
			warnings.push(`${at}: member ${member.key} is disabled: ${member.disabledReason}`);
		}
	}
	if (catalog) {
		const windows = usable.map((m) => catalog.find(m.provider, m.id)?.contextWindow).filter((w): w is number => typeof w === "number" && w > 0);
		if (windows.length > 1 && Math.max(...windows) > CONTEXT_SPREAD_WARNING * Math.min(...windows)) {
			warnings.push(`${at}: members' context windows range from ${Math.min(...windows)} to ${Math.max(...windows)} tokens`);
		}
		const byBase = new Map<string, Set<string>>();
		for (const member of usable) {
			const { base } = splitAccountProvider(member.provider, (n) => catalog.isProvider(n));
			byBase.set(base, (byBase.get(base) ?? new Set()).add(member.provider));
		}
		for (const [base, providers] of byBase) {
			if (providers.size > 1) {
				warnings.push(`${at}: pools ${providers.size} accounts of ${base}; pooling subscription accounts may breach the provider's terms`);
			}
		}
	}
	const tier: Tier = {
		name,
		rank: raw.rank,
		members,
		strategy: normalizeStrategy(raw.strategy, profileStrategy, errors, at),
		cooldown: { scope: raw.cooldown?.scope ?? "member", ...(raw.cooldown?.defaultMs ? { defaultMs: raw.cooldown.defaultMs } : {}) },
	};
	if (raw.affinity) tier.affinity = raw.affinity;
	return tier;
}

/** Errors in a ruleset as used by one profile. */
export function validateRuleset(ruleset: Ruleset, tierNames: string[], questions: QuestionSet): string[] {
	const errors: string[] = [];
	const tiers = tierNames.map((name, rank) => ({ name, rank }));
	const checkTarget = (target: unknown, what: string) => {
		if (typeof target !== "string") errors.push(`${what}: target must be a string`);
		else if (!isRankKeyword(target) && !resolveTarget(target, tiers)) errors.push(`${what}: unknown tier "${target}"`);
	};
	if (!isObject(ruleset) || !Array.isArray(ruleset.tierRules) || ruleset.tierRules.length === 0) {
		return ["a ruleset needs a non-empty tierRules list"];
	}
	const defaults = ruleset.tierRules.filter((rule) => rule.when === undefined);
	if (defaults.length !== 1 || ruleset.tierRules.at(-1)?.when !== undefined) {
		errors.push("tierRules must end with exactly one default rule (a rule without \"when\")");
	}
	ruleset.tierRules.forEach((rule, index) => {
		checkTarget(rule.tier, `tier rule ${index + 1}`);
		if (rule.when !== undefined) for (const reason of validateCondition(rule.when, questions)) errors.push(`tier rule ${index + 1}: ${reason}`);
	});
	(ruleset.floorRules ?? []).forEach((rule, index) => {
		checkTarget(rule.atLeast, `floor rule ${index + 1}`);
		if (rule.when === undefined) errors.push(`floor rule ${index + 1}: needs a "when" condition`);
		else for (const reason of validateCondition(rule.when, questions)) errors.push(`floor rule ${index + 1}: ${reason}`);
	});
	return errors;
}

function normalizeProfile(
	name: string,
	raw: ProfileConfig,
	rulesets: Record<string, Ruleset>,
	questions: QuestionSet,
	catalog: CatalogView | undefined,
	warnings: string[],
): { profile?: Profile; errors: string[] } {
	const errors: string[] = [];
	const where = `profile "${name}"`;
	if (!NAME_PATTERN.test(name)) errors.push(`${where}: profile names use lowercase letters, digits and dashes`);
	if (!isObject(raw) || !isObject(raw.tiers) || Object.keys(raw.tiers).length === 0) {
		return { errors: [...errors, `${where}: needs at least one tier`] };
	}
	const profileStrategy = raw.strategy === undefined ? undefined : normalizeStrategy(raw.strategy, undefined, errors, where);
	const tiers: Tier[] = [];
	for (const [tierName, tierConfig] of Object.entries(raw.tiers)) {
		const tier = normalizeTier(tierName, tierConfig, profileStrategy, catalog, errors, warnings, where);
		if (tier) tiers.push(tier);
	}
	tiers.sort((a, b) => a.rank - b.rank);
	const ranks = tiers.map((tier) => tier.rank);
	if (new Set(ranks).size !== ranks.length) errors.push(`${where}: two tiers share a rank`);

	let ruleset: Ruleset;
	let rulesetName: string;
	if (raw.ruleset === undefined || raw.ruleset === BUILTIN_RULESET_NAME) {
		ruleset = BUILTIN_RULESET;
		rulesetName = BUILTIN_RULESET_NAME;
	} else if (typeof raw.ruleset === "string") {
		const named = rulesets[raw.ruleset];
		if (!named) errors.push(`${where}: unknown ruleset "${raw.ruleset}"`);
		ruleset = named ?? BUILTIN_RULESET;
		rulesetName = raw.ruleset;
	} else {
		ruleset = raw.ruleset;
		rulesetName = "inline";
	}
	for (const reason of validateRuleset(ruleset, tiers.map((tier) => tier.name), questions)) errors.push(`${where} ruleset "${rulesetName}": ${reason}`);

	const resolve = (target: string | undefined, fallback: string, field: string): string => {
		const resolved = resolveTarget(target ?? fallback, tiers);
		if (!resolved) {
			errors.push(`${where}: ${field} "${target}" is not a tier of this profile`);
			return resolveTarget(fallback, tiers) ?? "";
		}
		return resolved;
	};
	const fallbackTier = resolve(raw.fallbackTier, "@middle", "fallbackTier");
	const baselineTier = resolve(raw.baselineTier, fallbackTier, "baselineTier");
	const directTier = resolve(raw.directTier, "@bottom", "directTier");

	if (raw.threshold !== undefined && !(raw.threshold > 0 && raw.threshold <= 1)) errors.push(`${where}: threshold must be in (0, 1]`);
	if (errors.length > 0) return { errors };

	const profile: Profile = {
		name,
		projects: Array.isArray(raw.projects) ? raw.projects : [],
		tiers,
		ruleset,
		rulesetName,
		fallbackTier,
		baselineTier,
		directTier,
		hysteresis: { downTurns: Math.max(1, raw.hysteresis?.downTurns ?? DEFAULTS.downTurns) },
		escalation: {
			sameToolErrors: raw.escalation?.sameToolErrors ?? DEFAULTS.escalation.sameToolErrors,
			totalToolErrors: raw.escalation?.totalToolErrors ?? DEFAULTS.escalation.totalToolErrors,
			maxPerTask: raw.escalation?.maxPerTask ?? DEFAULTS.escalation.maxPerTask,
		},
	};
	if (raw.description) profile.description = raw.description;
	if (raw.threshold !== undefined) profile.threshold = raw.threshold;
	if (raw.budgets) profile.budgets = raw.budgets;
	return { profile, errors };
}

/** Turns raw config into the engine's config, validating every profile independently. */
export function normalizeConfig(raw: RawConfig, options: NormalizeOptions = {}): Config {
	const warnings = [...(options.warnings ?? [])];
	if (raw.version !== undefined && raw.version !== 1) warnings.push(`unknown config version ${raw.version}; reading it as version 1`);
	const questions = normalizeQuestions(raw, warnings);

	const rulesets: Record<string, Ruleset> = {};
	for (const [name, ruleset] of Object.entries(raw.rulesets ?? {})) {
		if (name === BUILTIN_RULESET_NAME) warnings.push(`the ruleset name "${BUILTIN_RULESET_NAME}" is reserved; ignoring the user ruleset with that name`);
		else rulesets[name] = ruleset;
	}

	const profiles: Record<string, Profile> = {};
	const invalidProfiles: Record<string, string[]> = {};
	for (const [name, profileConfig] of Object.entries(raw.profiles ?? {})) {
		const { profile, errors } = normalizeProfile(name, profileConfig, rulesets, questions, options.catalog, warnings);
		if (profile) profiles[name] = profile;
		else invalidProfiles[name] = errors;
	}

	const selectionRules = (raw.profileSelection?.rules ?? []).filter((rule) => {
		const known = rule.profile in profiles || rule.profile in invalidProfiles;
		if (!known) warnings.push(`profileSelection rule names unknown profile "${rule.profile}"`);
		if (!rule.matchProvider && !rule.matchModel) warnings.push(`profileSelection rule for "${rule.profile}" has no matchProvider or matchModel`);
		return known && (rule.matchProvider || rule.matchModel);
	});
	const defaultProfile = raw.profileSelection?.default;
	if (defaultProfile && !(defaultProfile in profiles) && !(defaultProfile in invalidProfiles)) warnings.push(`profileSelection.default names unknown profile "${defaultProfile}"`);

	const classifiers = (raw.classifiers ?? []).filter((entry) => {
		const ok = typeof entry?.model === "string" && parseModelRef(entry.model) !== undefined;
		if (!ok) warnings.push(`classifier entry ${JSON.stringify(entry)} needs a provider/model reference`);
		return ok;
	}).map((entry) => ({ ...entry, timeoutMs: entry.timeoutMs ?? DEFAULTS.classifierTimeoutMs }));

	const evidence = raw.classification?.evidence;
	const config: Config = {
		version: 1,
		virtualModel: {
			provider: raw.virtualModel?.provider ?? "switchboard",
			id: raw.virtualModel?.id ?? "auto",
			name: raw.virtualModel?.name ?? "Switchboard",
		},
		classifierProviders: raw.classifierProviders ?? [],
		classifiers,
		classification: {
			threshold: raw.classification?.threshold ?? DEFAULTS.threshold,
			decisionBudgetMs: raw.classification?.decisionBudgetMs ?? DEFAULTS.decisionBudgetMs,
			questions,
			evidence: {
				maxTokens: evidence?.maxTokens ?? DEFAULTS.evidence.maxTokens,
				requestTokens: evidence?.requestTokens ?? DEFAULTS.evidence.requestTokens,
				toolErrors: {
					max: evidence?.toolErrors?.max ?? DEFAULTS.evidence.toolErrors.max,
					chars: evidence?.toolErrors?.chars ?? DEFAULTS.evidence.toolErrors.chars,
				},
				redact: evidence?.redact ?? [],
			},
		},
		profiles,
		invalidProfiles,
		profileSelection: { rules: selectionRules, ...(defaultProfile ? { default: defaultProfile } : {}) },
		subagents: {
			enabled: raw.subagents?.enabled ?? true,
			mode: raw.subagents?.mode ?? "auto",
			accountAffinity: raw.subagents?.accountAffinity ?? "parent",
			exclude: raw.subagents?.exclude ?? [],
			agents: raw.subagents?.agents ?? {},
			...(raw.subagents?.profile ? { profile: raw.subagents.profile } : {}),
		},
		failover: {
			accountSiblings: raw.failover?.accountSiblings ?? "off",
			overloadSwitchAfter: raw.failover?.overloadSwitchAfter ?? DEFAULTS.overloadSwitchAfter,
			errorClasses: raw.failover?.errorClasses ?? {},
		},
		metrics: { piUsage: raw.metrics?.piUsage ?? "auto", ledgerRetainDays: raw.metrics?.ledger?.retainDays ?? DEFAULTS.ledgerRetainDays },
		exhaustion: {
			borrow: raw.exhaustion?.borrow ?? ["up", "down"],
			autoContinue: raw.exhaustion?.autoContinue ?? false,
			maxWaitMs: raw.exhaustion?.maxWaitMs ?? DEFAULTS.maxWaitMs,
		},
		autoTier: { nameHints: { small: raw.autoTier?.nameHints?.small ?? [], large: raw.autoTier?.nameHints?.large ?? [] } },
		live: {
			mirror: raw.live?.mirror ?? true,
			toolResultBytes: raw.live?.toolResultBytes ?? DEFAULTS.toolResultBytes,
			retainHours: raw.live?.retainHours ?? DEFAULTS.retainHours,
		},
		state: { shared: raw.state?.shared ?? true },
		ui: {
			navigator: {
				shortcut: raw.ui?.navigator?.shortcut ?? DEFAULTS.shortcut,
				refreshMs: raw.ui?.navigator?.refreshMs ?? DEFAULTS.refreshMs,
				widget: raw.ui?.navigator?.widget ?? "auto",
			},
			status: raw.ui?.status ?? DEFAULTS.status,
			statusSub: raw.ui?.statusSub ?? DEFAULTS.statusSub,
			entries: raw.ui?.entries ?? "collapsed",
		},
		debug: {
			log: raw.debug?.log ?? false,
			fullEvidence: raw.debug?.fullEvidence ?? false,
			maxBytes: raw.debug?.maxBytes ?? DEFAULTS.debugMaxBytes,
			maxFiles: raw.debug?.maxFiles ?? DEFAULTS.debugMaxFiles,
		},
		warnings,
		sources: options.sources ?? [],
	};
	if (raw.classification?.temperature != null) config.classification.temperature = raw.classification.temperature;
	if (raw.profile) config.projectProfile = raw.profile;
	if (raw.budgets) config.budgets = raw.budgets;
	if (config.subagents.profile && !(config.subagents.profile in profiles)) warnings.push(`subagents.profile names unknown or invalid profile "${config.subagents.profile}"`);
	return config;
}
