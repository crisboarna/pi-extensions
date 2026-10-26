import { type ChainEntry, type ChainResult, type ClassifyFn, runClassifierChain } from "../classifier/chain.ts";
import { buildEvidence, type Evidence, type PlanPhase, type TranscriptMessage, toolResultsSinceUser } from "../classifier/evidence.ts";
import type { WarmupTracker } from "../classifier/warmup.ts";
import type { Config, Member, Profile, Tier } from "../config/types.ts";
import type { CandidateRecord, DecisionEntry, DecisionKind, ProfileSource } from "../record/types.ts";
import { evaluateRules, type RuleOutcome } from "../rules/evaluate.ts";
import { rankOf, resolveTarget } from "../rules/targets.ts";
import type { Answers, Signals } from "../rules/types.ts";
import { accountSiblings, type Subscription } from "../selection/accounts.ts";
import { classifyError, type ErrorClass, parseRetryAt, parseRetryHeaders } from "../selection/errors.ts";
import type { HealthStore } from "../selection/health.ts";
import {
	acquireLease,
	activeCooldown,
	borrowOrder,
	type CandidateView,
	cooldownKey,
	cooldownKeys,
	DEFAULT_FAILURE_CONFIG,
	type FailureConfig,
	type MemberInfo,
	modelKey,
	type QuotaView,
	recordFailure,
	recordSuccess,
	releaseLease,
	selectMember,
} from "../selection/select.ts";
import type { CustomSelect } from "../selection/strategies.ts";
import { decideUserTier, escalate, escalationTrigger } from "../tiering/decide.ts";
import { formatModelRef, shiftThinking, THINKING_LEVELS, type ThinkingLevel } from "../util/model-ref.ts";
import { type Clock, newId, type Rng } from "../util/runtime.ts";
import { chooseProfile, inactiveReason, type ProfileChoice } from "./profiles.ts";

/** Router state pi stores per session branch (`pi.virtual-model-state`). */
export interface RouterState {
	v: 1;
	profile?: string;
	profileSource?: ProfileSource;
	tier?: string;
	downVotes: number;
	/** Count of user turns seen on this branch; the task index. */
	task: number;
	member?: string;
	memberTier?: string;
	memberTask?: number;
	memberChosenAt?: number;
	escalatedTask?: number;
	escalations?: number;
	borrowedFrom?: string;
	lastDecisionId?: string;
}

export interface ModelChoice {
	provider: string;
	id: string;
	thinking?: string;
}

export interface RouteInput {
	/** Id of the selected virtual model: `auto`, `<profile>` or `<profile>.<tier>`. */
	virtualId: string;
	selectedThinking: ThinkingLevel;
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: ModelChoice;
	failed?: ModelChoice & { errorMessage?: string };
	state?: RouterState | undefined;
	messages: readonly TranscriptMessage[];
	signal?: AbortSignal;
	scope: "main" | "subagent";
	/** Subagent name, read from the child's system prompt. */
	agent?: string;
	/** Estimated tokens of the request, for direct context fit. */
	contextTokens?: number;
}

export interface RouteOutput {
	provider: string;
	id: string;
	thinking: ThinkingLevel;
	/** New state, or undefined to keep the current one. */
	state?: RouterState;
	decision?: DecisionEntry;
}

export interface EngineCatalog {
	find(provider: string, id: string): { contextWindow?: number; price?: number } | undefined;
	hasAuth(provider: string): boolean;
	isProvider(name: string): boolean;
	subscription(provider: string): boolean;
}

export interface EngineDeps {
	config: Config;
	/** True when no config file exists. */
	missingConfig: boolean;
	catalog: EngineCatalog;
	store: HealthStore;
	classify: ClassifyFn;
	/** Whether a classifier runs on this machine; when absent every classifier counts as local. */
	isLocalClassifier?: (model: string) => boolean;
	warmup?: WarmupTracker;
	clock: Clock;
	rng: Rng;
	cwd: string;
	home: string;
	planPhase: () => Promise<PlanPhase>;
	globalProfile: () => string | undefined;
	subscriptions: () => Subscription[];
	quota?: QuotaView;
	custom?: (module: string) => CustomSelect | undefined;
	/** Maps a member's provider onto an account (subagent account affinity). */
	accountFor?: (provider: string, id: string) => string;
	budget?: (profile: Profile) => DecisionEntry["budget"];
	failure?: Partial<FailureConfig>;
}

export interface Controls {
	pin?: { target: string; subagents: boolean };
	dryRun: boolean;
	profile?: string;
}

/** The classifier name `/tier try` records when typed answers stand in for a classifier. */
export const TYPED_ANSWERS = "typed/answers";

/** Raised when every member of every allowed tier is cooling down. */
export class ExhaustedError extends Error {
	readonly earliest?: { member: string; at: number } | undefined;
	constructor(earliest?: { member: string; at: number }) {
		const when = earliest ? `; earliest reset ${new Date(earliest.at).toLocaleTimeString()} on ${earliest.member}` : "";
		super(`pi-switchboard: every model is cooling down${when}`);
		this.earliest = earliest;
	}
}

/** A request that streams for longer than this is assumed dead; its lease expires. */
const REQUEST_LEASE_TTL_MS = 10 * 60_000;
/** Launch-mode children can run long and may be in the background; the lease expires on its own. */
export const LAUNCH_LEASE_TTL_MS = 15 * 60_000;

/** A claim on a model for requests in flight, shared across processes through the health file. */
export interface LeaseRef {
	key: string;
	id: string;
}

export type LaunchSelection =
	| {
			ok: true;
			tier: Tier;
			member: Member;
			/** The provider the model is served from (account affinity applied). */
			provider: string;
			borrowedFrom?: string;
			selection: DecisionEntry["selection"];
			lease: LeaseRef;
	  }
	| { ok: false; earliest?: { member: string; at: number } };

const MEDIUM = THINKING_LEVELS.indexOf("medium");
const MAX_RECENT = 50;

/** The member's thinking shifted by the user's selected level (medium = as configured). */
export function effectiveThinking(member: Pick<Member, "thinking">, selected: ThinkingLevel): ThinkingLevel {
	return shiftThinking(member.thinking ?? "medium", THINKING_LEVELS.indexOf(selected) - MEDIUM);
}

function parseVirtualId(id: string): { profile?: string; tier?: string } {
	if (id === "auto") return {};
	const dot = id.indexOf(".");
	return dot < 0 ? { profile: id } : { profile: id.slice(0, dot), tier: id.slice(dot + 1) };
}

function iso(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

function candidateRecords(views: readonly CandidateView[]): CandidateRecord[] {
	return views.map((view) => ({
		member: view.member.key,
		eligible: view.eligible,
		...(view.excluded ? { excluded: view.excluded } : {}),
		...(view.cooldownUntil ? { cooldownUntil: iso(view.cooldownUntil) } : {}),
		...(view.fails ? { fails: view.fails } : {}),
		...(view.inFlight ? { inFlight: view.inFlight } : {}),
		...(view.quota
			? { quota: { remaining: view.quota.remaining, source: view.quota.source, ...(view.quota.resetsAt ? { resetsAt: iso(view.quota.resetsAt) } : {}) } }
			: {}),
	}));
}

interface TierPick {
	tier: Tier;
	member: Member;
	borrowedFrom?: string;
	why: string;
	metricFallback?: string;
	kept: boolean;
	shared: boolean;
	candidates: CandidateView[];
}

/**
 * The routing engine behind every switchboard virtual model. Pure enough to
 * test without pi: models, classifiers, health and time come in through deps.
 */
export class SwitchboardEngine {
	deps: EngineDeps;
	controls: Controls = { dryRun: false };
	/** The physical model selected before routing, `provider/id`. */
	originModel?: string;
	readonly recent: DecisionEntry[] = [];
	private lastRoute?: { profile: string; tier: string; member: Member; provider: string };
	private requestLease?: LeaseRef | undefined;
	private readonly pending = new Map<string, { errorClass: ErrorClass; retryAt?: number; message?: string }>();

	constructor(deps: EngineDeps) {
		this.deps = deps;
	}

	get config(): Config {
		return this.deps.config;
	}

	/** Whether any profile can route. */
	get active(): boolean {
		return Object.keys(this.config.profiles).length > 0;
	}

	/** The configured classifiers as chain entries, marking remote ones that lack `allowRemote`. */
	classifierEntries(): ChainEntry[] {
		return this.config.classifiers.map((entry) => ({
			model: entry.model,
			timeoutMs: entry.timeoutMs,
			...(entry.threshold !== undefined ? { threshold: entry.threshold } : {}),
			...(this.deps.isLocalClassifier && !this.deps.isLocalClassifier(entry.model) ? { remote: true } : {}),
			...(entry.allowRemote ? { allowRemote: true } : {}),
		}));
	}

	inactiveReason(): string {
		return inactiveReason(this.config, this.deps.missingConfig);
	}

	resolveProfile(virtualId: string): { choice?: ProfileChoice; pinnedTier?: string } {
		const parsed = parseVirtualId(virtualId);
		const choice = chooseProfile({
			config: this.config,
			...(parsed.profile ? { fromModel: parsed.profile } : {}),
			...(this.controls.profile ? { manualSession: this.controls.profile } : {}),
			...(this.deps.globalProfile() ? { manualGlobal: this.deps.globalProfile() } : {}),
			...(this.originModel ? { originModel: this.originModel } : {}),
			cwd: this.deps.cwd,
			home: this.deps.home,
		});
		const pinnedTier = parsed.tier && choice ? resolveTarget(parsed.tier, choice.profile.tiers) : undefined;
		return { ...(choice ? { choice } : {}), ...(pinnedTier ? { pinnedTier } : {}) };
	}

	async route(input: RouteInput): Promise<RouteOutput> {
		switch (input.reason) {
			case "user":
				return this.routeUser(input);
			case "continuation":
				return this.routeContinuation(input);
			case "retry":
				return this.routeRetry(input);
			case "direct":
				return this.routeDirect(input);
		}
	}

	/** Takes an in-flight lease on a configured member's model. */
	takeLease(member: Pick<Member, "provider" | "id">, ttlMs: number): LeaseRef {
		const ref = { key: modelKey(member), id: newId("l_", this.deps.clock, this.deps.rng) };
		acquireLease(this.deps.store, ref.key, ref.id, this.deps.clock.now(), ttlMs);
		return ref;
	}

	releaseLease(ref: LeaseRef): void {
		releaseLease(this.deps.store, ref.key, ref.id, this.deps.clock.now());
	}

	/** Marks the routed model as streaming a request; a later request replaces the lease. */
	beginRequest(): void {
		this.endRequest();
		if (this.lastRoute) this.requestLease = this.takeLease(this.lastRoute.member, REQUEST_LEASE_TTL_MS);
	}

	/** The request finished (answered, failed or aborted). */
	endRequest(): void {
		if (!this.requestLease) return;
		this.releaseLease(this.requestLease);
		this.requestLease = undefined;
	}

	/**
	 * Picks the member a launch-mode subagent task will run on: the tier's
	 * strategy over healthy members, borrowing within the agent's tier limits,
	 * with an in-flight lease taken so parallel launches see each other.
	 */
	selectForLaunch(profile: Profile, tierName: string, task: number, agent: string | undefined): LaunchSelection {
		const pick = this.pickInTier(profile, tierName, undefined, task, { bounds: this.agentLimits(agent, profile) });
		if ("exhausted" in pick) return { ok: false, ...(pick.earliest ? { earliest: pick.earliest } : {}) };
		const selection = this.selectionRecord(pick);
		return {
			ok: true,
			tier: pick.tier,
			member: pick.member,
			provider: this.physical(pick.member).provider,
			...(pick.borrowedFrom ? { borrowedFrom: pick.borrowedFrom } : {}),
			...(selection ? { selection } : {}),
			lease: this.takeLease(pick.member, LAUNCH_LEASE_TTL_MS),
		} as LaunchSelection;
	}

	/** Called on `after_provider_response`: remembers the provider's retry time for the routed model. */
	noteResponse(status: number, headers: Record<string, string>): void {
		if (status < 400 || !this.lastRoute) return;
		const retryAt = parseRetryHeaders(headers, this.deps.clock.now());
		const key = modelKey(
			this.lastRoute.member.provider === this.lastRoute.provider
				? this.lastRoute.member
				: { provider: this.lastRoute.provider, id: this.lastRoute.member.id },
		);
		const existing = this.pending.get(key);
		this.pending.set(key, {
			errorClass: existing?.errorClass ?? (status === 429 ? "rate-limit" : "other"),
			...(retryAt ? { retryAt } : {}),
			...(existing?.message ? { message: existing.message } : {}),
		});
	}

	/**
	 * For a failed message pi will not retry (usage limits): records the real
	 * failure and says whether another model could take over, so the caller
	 * may rewrite the error into a retryable one (DESIGN.md 4.4).
	 */
	prepareFailover(failed: ModelChoice, errorMessage: string | undefined): { errorClass: ErrorClass; canFailOver: boolean } {
		const errorClass = classifyError(errorMessage, this.config.failover.errorClasses);
		if (errorClass !== "quota" && errorClass !== "auth") return { errorClass, canFailOver: false };
		const key = modelKey(failed);
		const retryAt = this.pending.get(key)?.retryAt ?? parseRetryAt(errorMessage, this.deps.clock.now());
		this.pending.set(key, { errorClass, ...(retryAt ? { retryAt } : {}), ...(errorMessage ? { message: errorMessage } : {}) });
		const now = this.deps.clock.now();
		// pi will not retry this error, so when nothing can take over it is recorded now and the next turn skips the account.
		const recordUnretried = () => {
			this.pending.delete(key);
			recordFailure(
				this.deps.store,
				{ member: `model:${key}`, model: `model:${key}`, provider: `provider:${failed.provider}` },
				errorClass,
				retryAt,
				now,
				{ ...DEFAULT_FAILURE_CONFIG, ...this.deps.failure },
			);
		};
		const route = this.lastRoute;
		const profile = route ? this.config.profiles[route.profile] : undefined;
		if (!route || !profile) {
			// No current route (for example right after a reload): nothing to fail over to, but the failure still counts.
			recordUnretried();
			return { errorClass, canFailOver: false };
		}
		const data = this.deps.store.read();
		// The failure is not recorded yet, so treat its scope as cooling too.
		const failedProvider = errorClass === "quota" || errorClass === "auth" ? failed.provider : undefined;
		const healthy = (tier: Tier) =>
			tier.members.some((m) => {
				const provider = this.physical(m).provider;
				if (!m.enabled || provider === failedProvider || `${provider}/${m.id}` === key) return false;
				return !activeCooldown(data, cooldownKeys(`${profile.name}/${tier.name}`, tier, m, provider), now);
			});
		const order = [route.tier, ...borrowOrder(profile.tiers, route.tier, this.config.exhaustion.borrow)];
		const canFailOver =
			order.some((name) => {
				const tier = profile.tiers.find((t) => t.name === name);
				return tier ? healthy(tier) : false;
			}) || this.siblingFor(failed) !== undefined;
		if (!canFailOver) recordUnretried();
		return { errorClass, canFailOver };
	}

	/** Marks a routed response as successful for health and latency. */
	noteSuccess(model: ModelChoice, latencyMs: number | undefined): void {
		const route = this.lastRoute;
		if (!route) return;
		const profile = this.config.profiles[route.profile];
		const tier = profile?.tiers.find((t) => t.name === route.tier);
		if (!tier || route.member.id !== model.id) return;
		recordSuccess(this.deps.store, cooldownKey(`${route.profile}/${route.tier}`, tier, route.member), modelKey(model), latencyMs);
		this.pending.delete(modelKey(model));
	}

	private remember(decision: DecisionEntry): DecisionEntry {
		this.recent.push(decision);
		if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
		return decision;
	}

	private info = (member: Member): MemberInfo => {
		const found = this.deps.catalog.find(member.provider, member.id);
		return {
			...(found?.price !== undefined ? { price: found.price } : {}),
			...(found?.contextWindow !== undefined ? { contextWindow: found.contextWindow } : {}),
			subscription: this.deps.catalog.subscription(member.provider),
		};
	};

	private pickInTier(
		profile: Profile,
		tierName: string,
		state: RouterState | undefined,
		task: number,
		options: { force?: boolean; exclude?: string[]; bounds?: { min?: string; max?: string } } = {},
	): TierPick | { exhausted: true; earliest?: { member: string; at: number } } {
		const order = [tierName, ...borrowOrder(profile.tiers, tierName, this.config.exhaustion.borrow, options.bounds)];
		let earliest: { member: string; at: number } | undefined;
		for (const name of order) {
			const tier = profile.tiers.find((t) => t.name === name);
			if (!tier) continue;
			const previous =
				state?.member && state.memberTier === name && state.memberTask !== undefined && state.memberChosenAt !== undefined
					? { key: state.member, task: state.memberTask, chosenAt: state.memberChosenAt }
					: undefined;
			const custom = tier.strategy.module ? this.deps.custom?.(tier.strategy.module) : undefined;
			const outcome = selectMember({
				tier,
				tierKey: `${profile.name}/${name}`,
				store: this.deps.store,
				now: this.deps.clock.now(),
				rng: this.deps.rng,
				task,
				info: this.info,
				physicalProvider: (member) => this.physical(member).provider,
				...(previous ? { previous } : {}),
				...(options.exclude ? { exclude: options.exclude } : {}),
				...(options.force ? { force: true } : {}),
				...(this.deps.quota ? { quota: this.deps.quota } : {}),
				...(custom ? { custom } : {}),
			});
			if (outcome.ok) {
				return {
					tier,
					member: outcome.member,
					why: outcome.why,
					...(outcome.metricFallback ? { metricFallback: outcome.metricFallback } : {}),
					kept: outcome.kept,
					shared: outcome.shared,
					candidates: outcome.candidates,
					...(name !== tierName ? { borrowedFrom: tierName } : {}),
				};
			}
			if (outcome.earliestReset && (!earliest || outcome.earliestReset.at < earliest.at)) earliest = outcome.earliestReset;
		}
		return { exhausted: true, ...(earliest ? { earliest } : {}) };
	}

	private physical(member: Member): { provider: string; id: string } {
		const provider = this.deps.accountFor ? this.deps.accountFor(member.provider, member.id) : member.provider;
		return { provider, id: member.id };
	}

	private siblingFor(failed: ModelChoice): string | undefined {
		if (this.config.failover.accountSiblings !== "on") return undefined;
		const now = this.deps.clock.now();
		const data = this.deps.store.read();
		for (const sibling of accountSiblings(failed.provider, this.deps.subscriptions(), (name) => this.deps.catalog.isProvider(name))) {
			if (!this.deps.catalog.find(sibling, failed.id) || !this.deps.catalog.hasAuth(sibling)) continue;
			if ((data.members[`model:${sibling}/${failed.id}`]?.cooldownUntil ?? 0) > now) continue;
			if ((data.members[`provider:${sibling}`]?.cooldownUntil ?? 0) > now) continue;
			return sibling;
		}
		return undefined;
	}

	private agentLimits(agent: string | undefined, profile: Profile): { min?: string; max?: string } {
		const limits = agent ? this.config.subagents.agents[agent] : undefined;
		const min = limits?.minTier ? resolveTarget(limits.minTier, profile.tiers) : undefined;
		const max = limits?.maxTier ? resolveTarget(limits.maxTier, profile.tiers) : undefined;
		return { ...(min ? { min } : {}), ...(max ? { max } : {}) };
	}

	private baseDecision(
		input: RouteInput,
		profile: Profile,
		source: ProfileSource,
		task: number,
		kind: DecisionKind,
		reason: DecisionEntry["reason"],
	): Pick<DecisionEntry, "v" | "id" | "ts" | "task" | "scope" | "reason" | "kind" | "profile" | "virtualModel"> {
		return {
			v: 1,
			id: newId("d_", this.deps.clock, this.deps.rng),
			ts: new Date(this.deps.clock.now()).toISOString(),
			task,
			scope: input.scope,
			reason,
			kind,
			profile: { name: profile.name, source },
			virtualModel: `${this.config.virtualModel.provider}/${input.virtualId}`,
		};
	}

	private modelRecord(member: Member, provider: string, thinking: ThinkingLevel): DecisionEntry["model"] {
		const found = this.deps.catalog.find(provider, member.id);
		return {
			provider,
			id: member.id,
			thinking,
			...(found?.contextWindow ? { contextWindow: found.contextWindow } : {}),
			subscription: this.deps.catalog.subscription(provider),
			...(provider !== member.provider ? { account: provider } : {}),
		};
	}

	private selectionRecord(pick: TierPick): DecisionEntry["selection"] {
		return {
			strategy: pick.tier.strategy.name,
			granularity: pick.tier.strategy.granularity,
			why: pick.why,
			...(pick.metricFallback ? { metricFallback: pick.metricFallback } : {}),
			kept: pick.kept,
			shared: pick.shared,
			candidates: candidateRecords(pick.candidates),
		};
	}

	private inactive(input: RouteInput, task: number): RouteOutput {
		const fallback =
			input.previous ??
			(this.originModel
				? { provider: this.originModel.slice(0, this.originModel.indexOf("/")), id: this.originModel.slice(this.originModel.indexOf("/") + 1) }
				: undefined);
		if (!fallback) throw new Error(`pi-switchboard is inactive: ${this.inactiveReason()}. Select a physical model or run /tier init.`);
		const thinking = (fallback.thinking as ThinkingLevel | undefined) ?? input.selectedThinking;
		const decision: DecisionEntry = {
			v: 1,
			id: newId("d_", this.deps.clock, this.deps.rng),
			ts: new Date(this.deps.clock.now()).toISOString(),
			task,
			scope: input.scope,
			reason: input.reason === "direct" ? "direct" : "user",
			kind: "inactive",
			profile: { name: "", source: "default" },
			tier: { candidate: "", chosen: "", rank: 0, why: this.inactiveReason() },
			model: { provider: fallback.provider, id: fallback.id, thinking },
			switch: { cacheMiss: false },
		};
		return { provider: fallback.provider, id: fallback.id, thinking, decision: input.reason === "user" ? this.remember(decision) : decision };
	}

	private async classify(
		input: RouteInput,
		profile: Profile,
		evidenceRequest?: string,
	): Promise<{ evidence: Evidence; chain: ChainResult; signals: Signals; outcome?: RuleOutcome }> {
		const planPhase = input.scope === "main" ? await this.deps.planPhase() : "unknown";
		const signals: Signals = { $scope: input.scope, $planMode: planPhase, ...(input.agent ? { $agent: input.agent } : {}) };
		const { evidence: limits, questions } = this.config.classification;
		const evidence = buildEvidence({
			messages: input.messages,
			scope: input.scope,
			planPhase,
			limits,
			redact: limits.redact,
			home: this.deps.home,
			...(input.agent ? { agent: { name: input.agent } } : {}),
			...(evidenceRequest !== undefined ? { request: evidenceRequest } : {}),
		});
		const chain = await runClassifierChain(
			this.classifierEntries(),
			{ state: evidence.state, questions },
			{
				classify: this.deps.classify,
				budgetMs: this.config.classification.decisionBudgetMs,
				clock: this.deps.clock,
				...(input.signal ? { signal: input.signal } : {}),
				...(this.config.classification.temperature ? { temperature: this.config.classification.temperature } : {}),
				...(this.deps.warmup ? { isWarm: this.deps.warmup.isWarm } : {}),
			},
		);
		if (!chain.ok) return { evidence, chain, signals };
		this.deps.warmup?.markWarm(chain.model);
		const threshold = profile.threshold ?? chain.threshold ?? this.config.classification.threshold;
		return { evidence, chain, signals, outcome: evaluateRules(profile, questions, chain.answers, signals, threshold) };
	}

	private async routeUser(input: RouteInput): Promise<RouteOutput> {
		const previousState = input.state;
		const task = (previousState?.task ?? 0) + 1;
		const { choice, pinnedTier } = this.resolveProfile(input.virtualId);
		if (!choice) return this.inactive(input, task);
		const profile = choice.profile;
		const sameProfile = previousState?.profile === profile.name;
		const base: RouterState = sameProfile && previousState ? { ...previousState, task } : { v: 1, downVotes: 0, task, profile: profile.name };
		base.profileSource = choice.source;

		const pin = pinnedTier ?? (input.scope === "main" || this.controls.pin?.subagents ? this.controls.pin?.target : undefined);
		const classify = !pinnedTier && (!pin || this.controls.dryRun);
		const classified = classify ? await this.classify(input, profile) : undefined;
		const decision = decideUserTier({
			profile,
			state: { ...(base.tier ? { tier: base.tier } : {}), downVotes: base.downVotes },
			...(classified?.outcome ? { outcome: classified.outcome } : {}),
			...(classified && !classified.chain.ok ? { classifierFailure: classified.chain.reason } : {}),
			...(pin ? { pin } : {}),
			dryRun: this.controls.dryRun,
		});
		const kind: DecisionKind = pinnedTier && input.scope === "subagent" ? "launch-tier" : decision.kind;
		const bounds = input.scope === "subagent" ? this.agentLimits(input.agent, profile) : {};
		const pick = this.pickInTier(profile, decision.tier, sameProfile ? previousState : undefined, task, { bounds });
		if ("exhausted" in pick) throw new ExhaustedError(pick.earliest);

		const physical = this.physical(pick.member);
		const thinking = effectiveThinking(pick.member, input.selectedThinking);
		const from = input.previous ? `${input.previous.provider}/${input.previous.id}` : undefined;
		const entry: DecisionEntry = {
			...this.baseDecision(input, profile, choice.source, task, pick.borrowedFrom ? "borrowed" : kind, "user"),
			...(classified
				? {
						evidence: {
							digest: classified.evidence.digest,
							excerpt: classified.evidence.excerpt,
							tokens: classified.evidence.tokens,
							truncated: classified.evidence.truncated,
							state: classified.evidence.state,
						},
						classifier: {
							...(classified.chain.ok ? { model: classified.chain.model, usage: classified.chain.usage } : { failure: classified.chain.reason }),
							latencyMs: classified.chain.ok ? classified.chain.latencyMs : classified.chain.attempts.reduce((sum, a) => sum + a.latencyMs, 0),
							attempts: classified.chain.attempts,
						},
						...(classified.chain.ok ? { answers: classified.chain.answers } : {}),
					}
				: {}),
			...(classified?.outcome
				? {
						rules: {
							ruleset: profile.rulesetName,
							matched: classified.outcome.ruleIndex,
							gate: classified.outcome.gate,
							floors: classified.outcome.floors,
						},
					}
				: {}),
			tier: {
				candidate: decision.candidate,
				chosen: pick.tier.name,
				...(base.tier ? { previous: base.tier } : {}),
				rank: pick.tier.rank,
				why: pick.borrowedFrom
					? `${decision.why}; borrowed from ${pick.tier.name} because every ${pick.borrowedFrom} member is unavailable`
					: decision.why,
				...(decision.downVotes ? { downVotes: decision.downVotes } : {}),
				...(pick.borrowedFrom ? { borrowedFrom: pick.borrowedFrom } : {}),
			},
			selection: this.selectionRecord(pick),
			model: this.modelRecord(pick.member, physical.provider, thinking),
			switch: { ...(from ? { from } : {}), cacheMiss: from !== undefined && from !== `${physical.provider}/${physical.id}` },
			...(this.controls.dryRun ? { dryRun: true } : {}),
		};
		const budget = this.deps.budget?.(profile);
		if (budget?.length) entry.budget = budget;

		const state: RouterState = {
			...base,
			tier: pick.borrowedFrom ? decision.tier : pick.tier.name,
			downVotes: decision.downVotes,
			member: pick.member.key,
			memberTier: pick.tier.name,
			memberTask: pick.kept ? (base.memberTask ?? task) : task,
			memberChosenAt: pick.kept ? (base.memberChosenAt ?? this.deps.clock.now()) : this.deps.clock.now(),
			lastDecisionId: entry.id,
		};
		delete state.escalatedTask;
		delete state.escalations;
		if (pick.borrowedFrom) state.borrowedFrom = pick.borrowedFrom;
		else delete state.borrowedFrom;
		this.lastRoute = { profile: profile.name, tier: pick.tier.name, member: pick.member, provider: physical.provider };
		return { ...physical, thinking, state, decision: this.remember(entry) };
	}

	private stateMember(state: RouterState | undefined): { profile: Profile; tier: Tier; member: Member } | undefined {
		const profile = state?.profile ? this.config.profiles[state.profile] : undefined;
		const tier = profile?.tiers.find((t) => t.name === state?.memberTier);
		const member = tier?.members.find((m) => m.key === state?.member);
		return profile && tier && member ? { profile, tier, member } : undefined;
	}

	private async routeContinuation(input: RouteInput): Promise<RouteOutput> {
		const state = input.state;
		const current = this.stateMember(state);
		if (!state?.tier || !current) return this.routeUser(input);
		const { profile } = current;
		const escalations = state.escalatedTask === state.task ? (state.escalations ?? 0) : 0;
		if (escalations < profile.escalation.maxPerTask) {
			const outcomes = toolResultsSinceUser(input.messages).map((m) => ({ tool: m.toolName ?? "unknown", isError: m.isError === true }));
			const trigger = escalationTrigger(outcomes, profile.escalation);
			const ceiling = input.scope === "subagent" ? this.agentLimits(input.agent, profile).max : undefined;
			const next = trigger ? escalate(state.tier, profile.tiers, ceiling) : state.tier;
			if (trigger && next !== state.tier) {
				const pick = this.pickInTier(profile, next, state, state.task, { force: true });
				if (!("exhausted" in pick)) {
					const physical = this.physical(pick.member);
					const thinking = effectiveThinking(pick.member, input.selectedThinking);
					const from = input.previous ? `${input.previous.provider}/${input.previous.id}` : undefined;
					const entry: DecisionEntry = {
						...this.baseDecision(input, profile, state.profileSource ?? "default", state.task, "escalated", "continuation"),
						tier: { candidate: next, chosen: pick.tier.name, previous: state.tier, rank: pick.tier.rank, why: `escalated: ${trigger}` },
						selection: this.selectionRecord(pick),
						model: this.modelRecord(pick.member, physical.provider, thinking),
						switch: { ...(from ? { from } : {}), cacheMiss: from !== `${physical.provider}/${physical.id}` },
					};
					const newState: RouterState = {
						...state,
						tier: pick.tier.name,
						member: pick.member.key,
						memberTier: pick.tier.name,
						memberTask: state.task,
						memberChosenAt: this.deps.clock.now(),
						escalatedTask: state.task,
						escalations: escalations + 1,
						lastDecisionId: entry.id,
					};
					this.lastRoute = { profile: profile.name, tier: pick.tier.name, member: pick.member, provider: physical.provider };
					return { ...physical, thinking, state: newState, decision: this.remember(entry) };
				}
			}
		}
		const previous = input.previous;
		if (previous) {
			this.lastRoute = { profile: profile.name, tier: current.tier.name, member: current.member, provider: previous.provider };
			return {
				provider: previous.provider,
				id: previous.id,
				thinking: (previous.thinking as ThinkingLevel | undefined) ?? effectiveThinking(current.member, input.selectedThinking),
			};
		}
		const physical = this.physical(current.member);
		return { ...physical, thinking: effectiveThinking(current.member, input.selectedThinking) };
	}

	private async routeRetry(input: RouteInput): Promise<RouteOutput> {
		const failed = input.failed;
		const state = input.state;
		const current = this.stateMember(state);
		if (!failed || !state || !current)
			return failed
				? { provider: failed.provider, id: failed.id, thinking: (failed.thinking as ThinkingLevel | undefined) ?? input.selectedThinking }
				: this.routeUser(input);
		const { profile } = current;
		const now = this.deps.clock.now();
		const key = modelKey(failed);
		const pending = this.pending.get(key);
		this.pending.delete(key);
		const message = pending?.message ?? failed.errorMessage;
		const errorClass =
			pending && pending.errorClass !== "other" ? pending.errorClass : classifyError(failed.errorMessage, this.config.failover.errorClasses);
		const retryAt = pending?.retryAt ?? parseRetryAt(message, now);
		const tier = current.member.id === failed.id ? current.tier : (profile.tiers.find((t) => t.members.some((m) => m.id === failed.id)) ?? current.tier);
		const member = tier.members.find((m) => m.id === failed.id && (m.provider === failed.provider || this.physical(m).provider === failed.provider));
		const keys = member
			? cooldownKeys(`${profile.name}/${tier.name}`, tier, member, failed.provider)
			: { member: `model:${key}`, model: `model:${key}`, provider: `provider:${failed.provider}` };
		// A tier's cooldown.defaultMs is how long a rate-limited member sits out when the provider gave no time.
		const failure = recordFailure(this.deps.store, keys, errorClass, retryAt, now, {
			...DEFAULT_FAILURE_CONFIG,
			overloadSwitchAfter: this.config.failover.overloadSwitchAfter,
			...(tier.cooldown.defaultMs ? { defaultCooldownMs: tier.cooldown.defaultMs } : {}),
			...this.deps.failure,
		});
		const keep: RouteOutput = {
			provider: failed.provider,
			id: failed.id,
			thinking: (failed.thinking as ThinkingLevel | undefined) ?? effectiveThinking(current.member, input.selectedThinking),
		};
		if (!failure.switchMember) return keep;

		const errorRecord = {
			class: errorClass,
			message: (message ?? "").slice(0, 300),
			...(failure.benchedUntil ? { benchedUntil: iso(failure.benchedUntil) } : {}),
		};
		const sibling = this.siblingFor(failed);
		if (sibling && member) {
			const thinking = keep.thinking;
			const entry: DecisionEntry = {
				...this.baseDecision(input, profile, state.profileSource ?? "default", state.task, "failover", "retry"),
				tier: { candidate: tier.name, chosen: tier.name, rank: tier.rank, why: `${failure.why}; same model on another account` },
				model: this.modelRecord(member, sibling, thinking),
				switch: { from: key, cacheMiss: true },
				error: errorRecord,
			};
			this.lastRoute = { profile: profile.name, tier: tier.name, member, provider: sibling };
			return { provider: sibling, id: failed.id, thinking, state: { ...state, lastDecisionId: entry.id }, decision: this.remember(entry) };
		}
		const bounds = input.scope === "subagent" ? this.agentLimits(input.agent, profile) : {};
		const pick = this.pickInTier(profile, state.tier ?? tier.name, state, state.task, { force: true, exclude: member ? [member.key] : [], bounds });
		if ("exhausted" in pick) throw new ExhaustedError(pick.earliest);
		const physical = this.physical(pick.member);
		const thinking = effectiveThinking(pick.member, input.selectedThinking);
		const entry: DecisionEntry = {
			...this.baseDecision(input, profile, state.profileSource ?? "default", state.task, pick.borrowedFrom ? "borrowed" : "failover", "retry"),
			tier: {
				candidate: state.tier ?? tier.name,
				chosen: pick.tier.name,
				rank: pick.tier.rank,
				why: pick.borrowedFrom ? `${failure.why}; borrowed from ${pick.tier.name}` : failure.why,
				...(pick.borrowedFrom ? { borrowedFrom: pick.borrowedFrom } : {}),
			},
			selection: this.selectionRecord(pick),
			model: this.modelRecord(pick.member, physical.provider, thinking),
			switch: { from: key, cacheMiss: key !== `${physical.provider}/${physical.id}` },
			error: errorRecord,
		};
		const newState: RouterState = {
			...state,
			member: pick.member.key,
			memberTier: pick.tier.name,
			memberTask: state.task,
			memberChosenAt: now,
			lastDecisionId: entry.id,
		};
		this.lastRoute = { profile: profile.name, tier: pick.tier.name, member: pick.member, provider: physical.provider };
		return { ...physical, thinking, state: newState, decision: this.remember(entry) };
	}

	private routeDirect(input: RouteInput): RouteOutput {
		const { choice } = this.resolveProfile(input.virtualId);
		const profile = choice?.profile ?? (this.lastRoute ? this.config.profiles[this.lastRoute.profile] : undefined);
		if (!profile) return this.inactive(input, 0);
		const needed = Math.ceil((input.contextTokens ?? 0) * 1.1);
		const start = profile.tiers.findIndex((t) => t.name === profile.directTier);
		for (const tier of profile.tiers.slice(Math.max(0, start))) {
			const pick = this.pickInTier(profile, tier.name, undefined, 0, { bounds: { min: tier.name, max: tier.name } });
			if ("exhausted" in pick) continue;
			const window = this.deps.catalog.find(pick.member.provider, pick.member.id)?.contextWindow;
			if (needed > 0 && window !== undefined && window < needed) continue;
			const physical = this.physical(pick.member);
			const thinking = effectiveThinking(pick.member, input.selectedThinking);
			const entry: DecisionEntry = {
				...this.baseDecision(input, profile, choice?.source ?? "default", 0, "direct", "direct"),
				tier: {
					candidate: profile.directTier,
					chosen: tier.name,
					rank: tier.rank,
					why: tier.name === profile.directTier ? "direct request on the direct tier" : `moved up to fit ${needed} tokens`,
				},
				selection: this.selectionRecord(pick),
				model: this.modelRecord(pick.member, physical.provider, thinking),
				switch: { cacheMiss: false },
			};
			return { ...physical, thinking, decision: this.remember(entry) };
		}
		const fallback = input.previous ?? (this.lastRoute ? { provider: this.lastRoute.provider, id: this.lastRoute.member.id } : undefined);
		if (!fallback) throw new ExhaustedError();
		return { provider: fallback.provider, id: fallback.id, thinking: (fallback.thinking as ThinkingLevel | undefined) ?? input.selectedThinking };
	}

	/**
	 * Routes `text` as a new user turn without any effect: health, pointers,
	 * leases and routing state stay as they are, and nothing is recorded.
	 * With `answers`, those stand in for the classifier (`/tier try`).
	 */
	async preview(text: string, options: { virtualId?: string; answers?: Answers } = {}): Promise<DecisionEntry | undefined> {
		const data = structuredClone(this.deps.store.read());
		const source = this.deps.store;
		const store: HealthStore = { shared: source.shared, degraded: source.degraded, read: () => data, update: (fn) => fn(data) };
		const { answers } = options;
		// Typed answers are gated like the first configured classifier's answers would be.
		const threshold = this.deps.config.classifiers[0]?.threshold;
		const twin = new SwitchboardEngine({
			...this.deps,
			store,
			...(answers
				? {
						config: {
							...this.deps.config,
							classifiers: [{ model: TYPED_ANSWERS, timeoutMs: 1000, ...(threshold !== undefined ? { threshold } : {}) }],
						},
						classify: async () => ({ stopReason: "stop" as const, answers }),
						isLocalClassifier: () => true,
					}
				: {}),
		});
		twin.controls = { ...this.controls, dryRun: false };
		if (this.originModel) twin.originModel = this.originModel;
		const out = await twin.route({
			virtualId: options.virtualId ?? "auto",
			selectedThinking: "medium",
			reason: "user",
			messages: [{ role: "user", content: text }],
			scope: "main",
		});
		return out.decision;
	}

	/** The tier rank a decision ended on, for display. */
	rankOf(profile: Profile, tier: string): number {
		return rankOf(tier, profile.tiers);
	}

	/** `provider/id:thinking` of the member a state points at. */
	describeState(state: RouterState | undefined): string | undefined {
		const current = this.stateMember(state);
		return current ? formatModelRef(this.physical(current.member)) : undefined;
	}
}
