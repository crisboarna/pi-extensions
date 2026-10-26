import type { Member, Tier } from "../config/types.ts";
import { entryOf } from "../util/record.ts";
import type { Rng } from "../util/runtime.ts";
import type { ErrorClass } from "./errors.ts";
import { type HealthData, type HealthStore, liveLeases, type MemberHealth } from "./health.ts";
import { type Candidate, type CustomSelect, pickMember } from "./strategies.ts";

/** What selection needs from pi's catalog, per member. */
export interface MemberInfo {
	price?: number;
	contextWindow?: number;
	subscription?: boolean;
}

export type QuotaView = (member: Member) => { remaining: number; resetsAt?: number; source: string } | undefined;

/** Health key of a physical model: in-flight leases, last use and latency are shared across tiers. */
export function modelKey(member: Pick<Member, "provider" | "id">): string {
	return `${member.provider}/${member.id}`;
}

/** Cooldown key: per member of a tier, or per physical model when the tier scopes it that way. */
export function cooldownKey(tierKey: string, tier: Pick<Tier, "cooldown">, member: Member): string {
	return tier.cooldown.scope === "provider-model-account" ? `model:${modelKey(member)}` : `member:${tierKey}/${member.key}`;
}

/** The three cooldown scopes of a member: the tier member, the physical model and the provider account. */
export interface CooldownKeys {
	member: string;
	model: string;
	provider: string;
}

export function cooldownKeys(tierKey: string, tier: Pick<Tier, "cooldown">, member: Member, physicalProvider: string = member.provider): CooldownKeys {
	return { member: cooldownKey(tierKey, tier, member), model: `model:${physicalProvider}/${member.id}`, provider: `provider:${physicalProvider}` };
}

/** The latest cooldown across a member's scopes, if one is still running. */
export function activeCooldown(data: HealthData, keys: CooldownKeys, now: number): { until: number; reason: string } | undefined {
	let best: { until: number; reason: string } | undefined;
	for (const key of [keys.member, keys.model, keys.provider]) {
		const health = data.members[key];
		if (health?.cooldownUntil && health.cooldownUntil > now && (!best || health.cooldownUntil > best.until))
			best = { until: health.cooldownUntil, reason: health.cooldownReason ?? "error" };
	}
	return best;
}

export interface CandidateView {
	member: Member;
	eligible: boolean;
	excluded?: string;
	cooldownUntil?: number;
	fails?: number;
	inFlight: number;
	quota?: { remaining: number; resetsAt?: number; source: string };
}

export interface SelectInput {
	tier: Tier;
	tierKey: string;
	store: HealthStore;
	now: number;
	rng: Rng;
	/** Member that last served this session in this tier, with the task it was chosen for. */
	previous?: { key: string; task: number; chosenAt: number };
	task: number;
	/** Members to skip, such as the one that just failed. */
	exclude?: readonly string[];
	info?: (member: Member) => MemberInfo;
	quota?: QuotaView;
	custom?: CustomSelect;
	/** Re-pick even when granularity would keep the previous member (failover, escalation). */
	force?: boolean;
	/** The provider a member is actually served from (account affinity); defaults to its own. */
	physicalProvider?: (member: Member) => string;
}

export type SelectOutcome =
	| { ok: true; member: Member; why: string; metricFallback?: string; kept: boolean; candidates: CandidateView[]; shared: boolean }
	| { ok: false; candidates: CandidateView[]; earliestReset?: { member: string; at: number }; shared: boolean };

function candidatesOf(input: SelectInput, data: HealthData): { views: CandidateView[]; eligible: Candidate[] } {
	const views: CandidateView[] = [];
	const eligible: Candidate[] = [];
	for (const member of input.tier.members) {
		const keys = cooldownKeys(input.tierKey, input.tier, member, input.physicalProvider?.(member));
		const memberHealth: MemberHealth = data.members[keys.member] ?? {};
		const cooling = activeCooldown(data, keys, input.now);
		const phys: MemberHealth = data.members[modelKey(member)] ?? {};
		const inFlight = liveLeases(phys, input.now).length;
		const quota = input.quota?.(member);
		let excluded: string | undefined;
		if (!member.enabled) excluded = member.disabledReason ?? "disabled";
		else if (cooling) excluded = `cooling down (${cooling.reason})`;
		else if (input.exclude?.includes(member.key)) excluded = "just failed";
		else if (member.maxConcurrency !== undefined && inFlight >= member.maxConcurrency) excluded = `at max concurrency (${inFlight})`;
		else if (quota && quota.remaining <= 0) excluded = "budget used up";
		views.push({
			member,
			eligible: !excluded,
			...(excluded ? { excluded } : {}),
			...(cooling ? { cooldownUntil: cooling.until } : {}),
			...(memberHealth.fails?.length ? { fails: memberHealth.fails.length } : {}),
			inFlight,
			...(quota ? { quota } : {}),
		});
		if (excluded) continue;
		const info = input.info?.(member) ?? {};
		eligible.push({
			member,
			inFlight,
			latencySamples: phys.latencySamples ?? 0,
			...(phys.lastUsedAt !== undefined ? { lastUsedAt: phys.lastUsedAt } : {}),
			...(phys.latencyEwma !== undefined ? { latencyEwma: phys.latencyEwma } : {}),
			...(info.price !== undefined ? { price: info.price } : {}),
			...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
			...(info.subscription !== undefined ? { subscription: info.subscription } : {}),
			...(quota ? { quota } : {}),
		});
	}
	return { views, eligible };
}

/** Whether granularity or affinity lets the previous member stay. */
function keepPrevious(input: SelectInput): boolean {
	if (input.force || !input.previous) return false;
	const { tier, previous } = input;
	if (tier.affinity) {
		const ttl = tier.affinity.ttlMs;
		const fresh = !ttl || input.now - previous.chosenAt < ttl;
		const sameScope = tier.affinity.scope === "session" || previous.task === input.task;
		if (fresh && sameScope) return true;
	}
	if (tier.strategy.granularity === "session") return true;
	if (tier.strategy.granularity === "task") return previous.task === input.task;
	return false;
}

/**
 * Chooses a member of a tier: keeps the previous member while its granularity
 * or affinity allows, otherwise runs the strategy over eligible members.
 * Records the choice's last-use time in the shared health data.
 */
export function selectMember(input: SelectInput): SelectOutcome {
	return input.store.update((data) => {
		const { views, eligible } = candidatesOf(input, data);
		const shared = input.store.shared;
		if (eligible.length === 0) {
			const cooling = views.filter((view) => view.cooldownUntil !== undefined).sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0))[0];
			return {
				ok: false,
				candidates: views,
				shared,
				...(cooling?.cooldownUntil ? { earliestReset: { member: cooling.member.key, at: cooling.cooldownUntil } } : {}),
			};
		}
		const previous = input.previous ? eligible.find((c) => c.member.key === input.previous?.key) : undefined;
		if (previous && keepPrevious(input)) {
			touch(data, previous.member, input.now);
			return {
				ok: true,
				member: previous.member,
				why: `kept ${previous.member.key} (${input.tier.affinity ? "affinity" : `${input.tier.strategy.granularity} granularity`})`,
				kept: true,
				candidates: views,
				shared,
			};
		}
		const pick = pickMember(eligible, input.tier.strategy, {
			tierKey: input.tierKey,
			now: input.now,
			rng: input.rng,
			data,
			degraded: input.store.degraded,
			...(input.previous ? { previous: input.previous.key } : {}),
			...(input.custom ? { custom: input.custom } : {}),
		});
		if (!pick) return { ok: false, candidates: views, shared };
		touch(data, pick.member, input.now);
		return {
			ok: true,
			member: pick.member,
			why: pick.why,
			...(pick.metricFallback ? { metricFallback: pick.metricFallback } : {}),
			kept: false,
			candidates: views,
			shared,
		};
	});
}

function touch(data: HealthData, member: Member, now: number): void {
	const phys = entryOf(data.members, modelKey(member), () => ({}));
	phys.lastUsedAt = now;
}

export interface FailureConfig {
	defaultCooldownMs: number;
	overloadSwitchAfter: number;
	/** Server errors allowed within `failWindowMs` before benching. */
	allowedFails: number;
	failWindowMs: number;
	serverBenchMs: number;
	quotaBenchMs: number;
	authBenchMs: number;
}

export const DEFAULT_FAILURE_CONFIG: FailureConfig = {
	defaultCooldownMs: 5 * 60_000,
	overloadSwitchAfter: 2,
	allowedFails: 3,
	failWindowMs: 60_000,
	serverBenchMs: 60_000,
	quotaBenchMs: 60 * 60_000,
	authBenchMs: 60 * 60_000,
};

export interface FailureOutcome {
	/** Whether to move to another member now. */
	switchMember: boolean;
	benchedUntil?: number;
	why: string;
}

/** Usage limits and failed logins cover the whole account; rate limits the model; the rest the member. */
export function failureKey(target: string | CooldownKeys, errorClass: ErrorClass): string {
	if (typeof target === "string") return target;
	if (errorClass === "quota" || errorClass === "auth") return target.provider;
	if (errorClass === "rate-limit") return target.model;
	return target.member;
}

/**
 * Updates health after a failed request and says whether to fail over.
 * Overloads retry later without benching; quota, rate-limit and auth errors
 * bench until the provider's reset or a configured default, at the scope the
 * error covers (`failureKey`).
 */
export function recordFailure(
	store: HealthStore,
	target: string | CooldownKeys,
	errorClass: ErrorClass,
	retryAt: number | undefined,
	now: number,
	config: FailureConfig = DEFAULT_FAILURE_CONFIG,
): FailureOutcome {
	const key = failureKey(target, errorClass);
	return store.update((data) => {
		const health = entryOf(data.members, key, () => ({}));
		const bench = (until: number, reason: string): FailureOutcome => {
			health.cooldownUntil = Math.max(health.cooldownUntil ?? 0, until);
			health.cooldownReason = reason;
			return { switchMember: true, benchedUntil: health.cooldownUntil, why: `${reason}; benched until ${new Date(health.cooldownUntil).toISOString()}` };
		};
		switch (errorClass) {
			case "quota":
				return bench(retryAt ?? now + config.quotaBenchMs, "usage limit");
			case "rate-limit":
				return bench(retryAt ?? now + config.defaultCooldownMs, "rate limit");
			case "auth":
				return bench(now + config.authBenchMs, "authentication failed");
			case "overloaded": {
				health.overloads = (health.overloads ?? 0) + 1;
				const switchMember = health.overloads >= config.overloadSwitchAfter;
				return { switchMember, why: `overloaded ${health.overloads} time(s); ${switchMember ? "switching member" : "retrying the same member"}` };
			}
			case "server": {
				health.fails = [...(health.fails ?? []).filter((at) => now - at < config.failWindowMs), now];
				if (health.fails.length >= config.allowedFails) {
					health.fails = [];
					return bench(now + config.serverBenchMs, `${config.allowedFails} server errors in ${config.failWindowMs / 1000} s`);
				}
				return { switchMember: false, why: `server error ${health.fails.length} of ${config.allowedFails} allowed` };
			}
			default:
				return { switchMember: false, why: `${errorClass} error; keeping the member` };
		}
	});
}

const LATENCY_ALPHA = 0.3;

/** Clears failure counters and folds a latency sample into the model's average. */
export function recordSuccess(store: HealthStore, coolKey: string, physKey: string, latencyMs: number | undefined): void {
	store.update((data) => {
		const cool = data.members[coolKey];
		if (cool) {
			delete cool.overloads;
			delete cool.fails;
		}
		if (latencyMs === undefined || latencyMs <= 0) return;
		const phys = entryOf(data.members, physKey, () => ({}));
		phys.latencyEwma = phys.latencyEwma === undefined ? latencyMs : LATENCY_ALPHA * latencyMs + (1 - LATENCY_ALPHA) * phys.latencyEwma;
		phys.latencySamples = (phys.latencySamples ?? 0) + 1;
	});
}

/** Takes an in-flight lease on a physical model; returns its id. */
export function acquireLease(store: HealthStore, physKey: string, id: string, now: number, ttlMs: number, pid: number = process.pid): string {
	store.update((data) => {
		const phys = entryOf(data.members, physKey, () => ({}));
		phys.leases = [...liveLeases(phys, now), { id, pid, expiresAt: now + ttlMs }];
	});
	return id;
}

export function releaseLease(store: HealthStore, physKey: string, id: string, now: number): void {
	store.update((data) => {
		const phys = data.members[physKey];
		if (phys) phys.leases = liveLeases(phys, now).filter((lease) => lease.id !== id);
	});
}

/**
 * Tiers to borrow from when every member of `tier` is unavailable: nearest
 * above first, then nearest below (or as `order` says), within the bounds.
 */
export function borrowOrder(
	tiers: ReadonlyArray<{ name: string }>,
	tier: string,
	order: ReadonlyArray<"up" | "down">,
	bounds: { min?: string; max?: string } = {},
): string[] {
	const index = tiers.findIndex((t) => t.name === tier);
	if (index < 0) return [];
	const low = bounds.min
		? Math.max(
				0,
				tiers.findIndex((t) => t.name === bounds.min),
			)
		: 0;
	const highIndex = bounds.max ? tiers.findIndex((t) => t.name === bounds.max) : tiers.length - 1;
	const high = highIndex < 0 ? tiers.length - 1 : highIndex;
	const up = tiers.slice(index + 1, high + 1).map((t) => t.name);
	const down = tiers
		.slice(low, index)
		.map((t) => t.name)
		.reverse();
	return order.flatMap((direction) => (direction === "up" ? up : down));
}
