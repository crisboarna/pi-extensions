import type { Member, ScheduleWindow, StrategyName, StrategySpec } from "../config/types.ts";
import type { Rng } from "../util/runtime.ts";
import type { HealthData } from "./health.ts";

/** A member that passed the eligibility checks, with the metrics strategies read. */
export interface Candidate {
	member: Member;
	lastUsedAt?: number;
	inFlight: number;
	latencyEwma?: number;
	latencySamples: number;
	/** Blended price per million tokens (input and output weighted 3:1), when the catalog has one. */
	price?: number;
	contextWindow?: number;
	/** Whether the member's provider uses a subscription login (OAuth). */
	subscription?: boolean;
	/** Remaining fraction of the member's quota, and when it resets. */
	quota?: { remaining: number; resetsAt?: number; source: string };
}

export interface StrategyContext {
	/** `<profile>/<tier>`; keys round-robin pointers and weighted counters. */
	tierKey: string;
	now: number;
	rng: Rng;
	data: HealthData;
	/** Member key that last served this session in this tier. */
	previous?: string;
	/** The shared lock was unavailable: round robin starts at a random offset so processes spread out. */
	degraded: boolean;
	/** A user module's select function, already loaded. */
	custom?: CustomSelect;
}

export type CustomSelect = (members: ReadonlyArray<Readonly<Candidate>>, context: Readonly<{ tierKey: string; now: number; previous?: string }>) => string | undefined;

export interface Pick {
	member: Member;
	why: string;
	/** Set when the strategy's metric was missing and its fallback chose. */
	metricFallback?: string;
}

type Strategy = (candidates: Candidate[], spec: StrategySpec, ctx: StrategyContext) => Pick | undefined;

const byIndex = (a: Candidate, b: Candidate) => a.member.index - b.member.index;

const ordered: Strategy = (candidates) => {
	const first = [...candidates].sort(byIndex)[0];
	return first ? { member: first.member, why: "first healthy member in list order" } : undefined;
};

const sticky: Strategy = (candidates, _spec, ctx) => {
	const previous = candidates.find((c) => c.member.key === ctx.previous);
	if (previous) return { member: previous.member, why: "kept the member that last served this session" };
	const first = ordered(candidates, _spec, ctx);
	return first ? { ...first, why: "no previous member; first healthy member in list order" } : undefined;
};

const roundRobin: Strategy = (candidates, _spec, ctx) => {
	const sorted = [...candidates].sort(byIndex);
	const stored = ctx.data.pointers[ctx.tierKey];
	const pointer = stored ?? (ctx.degraded ? Math.floor(ctx.rng.next() * 1000) : -1);
	const maxIndex = Math.max(...sorted.map((c) => c.member.index)) + 1;
	const next = sorted.find((c) => c.member.index > pointer % maxIndex) ?? sorted[0];
	if (!next) return undefined;
	ctx.data.pointers[ctx.tierKey] = next.member.index;
	return { member: next.member, why: `round robin: next after position ${(pointer % maxIndex) + 1}` };
};

/** Smooth weighted round robin (nginx): even spread in proportion to weight. */
const weighted: Strategy = (candidates, _spec, ctx) => {
	const counters = (ctx.data.swrr[ctx.tierKey] ??= {});
	let total = 0;
	let best: Candidate | undefined;
	for (const candidate of [...candidates].sort(byIndex)) {
		const weight = candidate.member.weight;
		total += weight;
		counters[candidate.member.key] = (counters[candidate.member.key] ?? 0) + weight;
		if (!best || (counters[candidate.member.key] ?? 0) > (counters[best.member.key] ?? 0)) best = candidate;
	}
	if (!best) return undefined;
	counters[best.member.key] = (counters[best.member.key] ?? 0) - total;
	return { member: best.member, why: `smooth weighted round robin (weight ${best.member.weight} of ${total})` };
};

const random: Strategy = (candidates, _spec, ctx) => {
	const total = candidates.reduce((sum, c) => sum + c.member.weight, 0);
	let roll = ctx.rng.next() * total;
	for (const candidate of [...candidates].sort(byIndex)) {
		roll -= candidate.member.weight;
		if (roll < 0) return { member: candidate.member, why: "random, weighted by weight" };
	}
	const last = candidates.at(-1);
	return last ? { member: last.member, why: "random, weighted by weight" } : undefined;
};

const leastRecentlyUsed: Strategy = (candidates) => {
	const best = [...candidates].sort((a, b) => (a.lastUsedAt ?? -1) - (b.lastUsedAt ?? -1) || byIndex(a, b))[0];
	return best ? { member: best.member, why: best.lastUsedAt === undefined ? "least recently used (never used)" : "least recently used" } : undefined;
};

const leastInFlight: Strategy = (candidates) => {
	const best = [...candidates].sort((a, b) => a.inFlight - b.inFlight || byIndex(a, b))[0];
	return best ? { member: best.member, why: `fewest requests in flight (${best.inFlight})` } : undefined;
};

/** Ranks by a metric; members without it come last; none with it means the metric is missing. */
function byMetric(metric: (c: Candidate) => number | undefined, better: "low" | "high", label: string): Strategy {
	return (candidates) => {
		const known = candidates.filter((c) => metric(c) !== undefined);
		if (known.length === 0) return undefined;
		const sign = better === "low" ? 1 : -1;
		const best = [...known].sort((a, b) => sign * ((metric(a) ?? 0) - (metric(b) ?? 0)) || byIndex(a, b))[0];
		return best ? { member: best.member, why: `${label} (${metric(best)})` } : undefined;
	};
}

const quotaHeadroom = byMetric((c) => c.quota?.remaining, "high", "most quota remaining");
const cheapest = byMetric((c) => c.price, "low", "cheapest by catalog price");
const largestContext = byMetric((c) => c.contextWindow, "high", "largest context window");

const soonestReset: Strategy = (candidates) => {
	const usable = candidates.filter((c) => c.quota?.resetsAt !== undefined && c.quota.remaining >= 0.05);
	const best = usable.sort((a, b) => (a.quota?.resetsAt ?? 0) - (b.quota?.resetsAt ?? 0) || byIndex(a, b))[0];
	return best ? { member: best.member, why: "quota resets soonest (use it or lose it)" } : undefined;
};

const MIN_LATENCY_SAMPLES = 3;
const fastest: Strategy = (candidates) => {
	if (candidates.some((c) => c.latencySamples < MIN_LATENCY_SAMPLES)) return undefined;
	const best = [...candidates].sort((a, b) => (a.latencyEwma ?? Infinity) - (b.latencyEwma ?? Infinity) || byIndex(a, b))[0];
	return best ? { member: best.member, why: `fastest first token (${Math.round(best.latencyEwma ?? 0)} ms average)` } : undefined;
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function dayMatches(spec: string | undefined, day: number): boolean {
	if (!spec || spec === "daily") return true;
	return spec.split(",").some((part) => {
		const [from, to] = part.trim().toLowerCase().split("-");
		const start = DAYS.indexOf(from ?? "");
		if (start < 0) return false;
		if (!to) return start === day;
		const end = DAYS.indexOf(to);
		return start <= end ? day >= start && day <= end : day >= start || day <= end;
	});
}

function minutes(time: string): number {
	const [h, m] = time.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}

export function inSchedule(schedule: readonly ScheduleWindow[] | undefined, now: number): boolean {
	if (!schedule || schedule.length === 0) return true;
	const date = new Date(now);
	const minute = date.getHours() * 60 + date.getMinutes();
	return schedule.some((window) => {
		if (!dayMatches(window.days, date.getDay())) return false;
		const from = minutes(window.from);
		const to = minutes(window.to);
		return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
	});
}

const STRATEGIES: Record<Exclude<StrategyName, "subscription-preferred" | "scheduled" | "custom">, Strategy> = {
	ordered,
	sticky,
	"round-robin": roundRobin,
	weighted,
	random,
	"least-recently-used": leastRecentlyUsed,
	"least-in-flight": leastInFlight,
	"quota-headroom": quotaHeadroom,
	"soonest-reset": soonestReset,
	cheapest,
	"largest-context": largestContext,
	fastest,
};

function runFallback(candidates: Candidate[], spec: StrategySpec, ctx: StrategyContext, reason: string): Pick | undefined {
	const fallback = spec.fallback in STRATEGIES ? STRATEGIES[spec.fallback as keyof typeof STRATEGIES] : ordered;
	const pick = fallback(candidates, spec, ctx);
	return pick ? { ...pick, metricFallback: `${reason}; used ${spec.fallback}` } : undefined;
}

/** Picks one member with the tier's strategy, falling back when its metric is missing. */
export function pickMember(candidates: Candidate[], spec: StrategySpec, ctx: StrategyContext): Pick | undefined {
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1 && spec.name !== "round-robin" && spec.name !== "weighted") {
		const only = candidates[0];
		return only ? { member: only.member, why: "only eligible member" } : undefined;
	}
	switch (spec.name) {
		case "subscription-preferred": {
			const preferred = candidates.filter((c) => c.subscription);
			const pool = preferred.length ? preferred : candidates;
			const pick = runFallback(pool, spec, ctx, preferred.length ? "subscription members first" : "no subscription member");
			return pick ? { member: pick.member, why: `${preferred.length ? "subscription member" : "no subscription member"}; ${pick.why}` } : undefined;
		}
		case "scheduled": {
			const inside = candidates.filter((c) => inSchedule(c.member.schedule, ctx.now));
			const pool = inside.length ? inside : candidates;
			const pick = runFallback(pool, spec, ctx, inside.length ? "members in their time window" : "no member in its time window");
			return pick ? { member: pick.member, why: `${inside.length ? "in its time window" : "no member in its time window"}; ${pick.why}` } : undefined;
		}
		case "custom": {
			try {
				const key = ctx.custom?.(candidates, { tierKey: ctx.tierKey, now: ctx.now, ...(ctx.previous ? { previous: ctx.previous } : {}) });
				const chosen = candidates.find((c) => c.member.key === key);
				if (chosen) return { member: chosen.member, why: "custom strategy" };
				return runFallback(candidates, spec, ctx, ctx.custom ? "custom strategy chose no eligible member" : "custom strategy not loaded");
			} catch (error) {
				return runFallback(candidates, spec, ctx, `custom strategy failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		default: {
			const pick = STRATEGIES[spec.name](candidates, spec, ctx);
			return pick ?? runFallback(candidates, spec, ctx, `${spec.name} metric unavailable`);
		}
	}
}

/** Loads a user module whose `select` (or default export) is a CustomSelect. */
export async function loadCustomStrategy(path: string, home: string): Promise<CustomSelect> {
	const { pathToFileURL } = await import("node:url");
	const resolved = path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
	const module = (await import(pathToFileURL(resolved).href)) as { select?: unknown; default?: unknown };
	const select = typeof module.select === "function" ? module.select : module.default;
	if (typeof select !== "function") throw new Error(`${path} exports no select function`);
	return select as CustomSelect;
}
