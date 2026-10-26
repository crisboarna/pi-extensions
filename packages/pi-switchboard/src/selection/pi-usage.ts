import type { Member } from "../config/types.ts";
import { type Clock, systemClock } from "../util/runtime.ts";

/**
 * Client for pi-usage's read-only `usage:query:v1` protocol (its
 * docs/api/usage-v1.md). The types are declared here structurally, as that
 * document asks, so pi-usage does not have to be installed or imported.
 */
export const QUERY_CHANNEL = "usage:query:v1";
export const CHANGED_CHANNEL = "usage:changed:v1";

export interface UsageBucket {
	id: string;
	label: string;
	modelKeys?: string[];
	used?: number;
	remaining?: number;
	limit?: number;
	unit: "percent" | "usd" | "currency" | "count";
	windowMinutes?: number;
	/** Epoch milliseconds. */
	resetsAt?: number;
}

export interface UsageReport {
	providerId: string;
	capturedAt: number;
	buckets: UsageBucket[];
}

export type UsageOutcome =
	| { status: "ready"; report: UsageReport; expiresAt: number }
	| { status: "unavailable"; reason: string }
	| { status: "no-service" | "protocol-error" | "timeout" | "cancelled" };

export interface EventsLike {
	emit(channel: string, data: unknown): void;
	on?(channel: string, handler: (data: unknown) => void): () => void;
}

export interface QueryOptions {
	events: EventsLike;
	/** The exact `ctx.sessionManager` object and its id: the service answers only its own session. */
	session: unknown;
	sessionId: string;
	providerId: string;
	refresh: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBucket(raw: unknown): UsageBucket | undefined {
	if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.unit !== "string") return undefined;
	const bucket: UsageBucket = { id: raw.id, label: typeof raw.label === "string" ? raw.label : raw.id, unit: raw.unit as UsageBucket["unit"] };
	for (const key of ["used", "remaining", "limit", "windowMinutes", "resetsAt"] as const) {
		const value = finite(raw[key]);
		if (value !== undefined) bucket[key] = value;
	}
	if (Array.isArray(raw.modelKeys)) bucket.modelKeys = raw.modelKeys.filter((k): k is string => typeof k === "string");
	return bucket;
}

/** Validates a service result; anything malformed is a local protocol error. */
export function parseResult(raw: unknown, providerId: string): UsageOutcome {
	if (!isObject(raw)) return { status: "protocol-error" };
	if (raw.status === "unavailable") return { status: "unavailable", reason: typeof raw.reason === "string" ? raw.reason : "unknown" };
	if (raw.status !== "ready" || !isObject(raw.report)) return { status: "protocol-error" };
	const buckets = Array.isArray(raw.report.buckets) ? raw.report.buckets.flatMap((b) => parseBucket(b) ?? []) : [];
	const expiresAt = finite(raw.expiresAt) ?? 0;
	return {
		status: "ready",
		expiresAt,
		report: {
			providerId: typeof raw.report.providerId === "string" ? raw.report.providerId : providerId,
			capturedAt: finite(raw.report.capturedAt) ?? 0,
			buckets,
		},
	};
}

/**
 * Asks the usage service for one provider's report. `emit` returns nothing,
 * so the service answers through `respond()` during dispatch with a value or
 * a promise; no offer means no service. The deadline aborts the request.
 */
export async function queryUsage(options: QueryOptions): Promise<UsageOutcome> {
	if (options.signal?.aborted) return { status: "cancelled" };
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let offer: Promise<unknown> | undefined;
	let open = true;
	const request = {
		session: options.session,
		sessionId: options.sessionId,
		providerId: options.providerId,
		refresh: options.refresh,
		signal: controller.signal,
		respond(result: unknown): boolean {
			if (!open || offer) return false;
			offer = Promise.resolve(result);
			return true;
		},
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		options.events.emit(QUERY_CHANNEL, request);
		open = false;
		if (!offer) return { status: "no-service" };
		const pending = offer.then(
			(value) => parseResult(value, options.providerId),
			() => ({ status: "protocol-error" }) as UsageOutcome,
		);
		const deadline = new Promise<UsageOutcome>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve({ status: "timeout" });
			}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			timer.unref?.();
		});
		const cancelled = new Promise<UsageOutcome>((resolve) => {
			options.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
		});
		return await Promise.race([pending, deadline, cancelled]);
	} catch {
		return { status: "protocol-error" };
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export interface Quota {
	/** Share of the binding allowance still available, 0 to 1. */
	remaining: number;
	/** Epoch milliseconds when the binding window resets. */
	resetsAt?: number;
	source: string;
}

function fraction(bucket: UsageBucket): number | undefined {
	const limit = bucket.unit === "percent" ? (bucket.limit ?? 100) : bucket.limit;
	if (!limit || limit <= 0) return undefined;
	const share = bucket.remaining !== undefined ? bucket.remaining / limit : bucket.used !== undefined ? (limit - bucket.used) / limit : undefined;
	return share === undefined ? undefined : Math.min(1, Math.max(0, share));
}

/**
 * The tightest allowance that applies to a model: among buckets for that
 * model (or buckets that name no models), the one with the least left.
 * Buckets with unknown measurements are skipped; none known means no quota.
 */
export function quotaFromReport(report: UsageReport, modelId: string): Quota | undefined {
	let best: { share: number; resetsAt?: number } | undefined;
	for (const bucket of report.buckets) {
		if (bucket.modelKeys && bucket.modelKeys.length > 0 && !bucket.modelKeys.includes(modelId)) continue;
		const share = fraction(bucket);
		if (share === undefined) continue;
		if (!best || share < best.share) best = { share, ...(bucket.resetsAt !== undefined ? { resetsAt: bucket.resetsAt } : {}) };
	}
	return best ? { remaining: best.share, ...(best.resetsAt !== undefined ? { resetsAt: best.resetsAt } : {}), source: "pi-usage" } : undefined;
}

export interface UsageCacheOptions {
	events: EventsLike;
	/** The current session manager and id, or undefined before a session exists. */
	session: () => { sessionManager: unknown; sessionId: string } | undefined;
	clock?: Clock;
	/** How long a report is trusted, at most; the service's own `expiresAt` also applies. */
	ttlMs?: number;
	timeoutMs?: number;
}

interface CachedReport {
	report: UsageReport;
	validUntil: number;
}

/**
 * A synchronous view of pi-usage quota for the selection code. Reports are
 * refreshed in the background, never on the routing path, and only for
 * providers a quota strategy needs.
 */
export class UsageCache {
	private readonly options: UsageCacheOptions;
	private readonly clock: Clock;
	private readonly reports = new Map<string, CachedReport>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly backoff = new Map<string, number>();

	constructor(options: UsageCacheOptions) {
		this.options = options;
		this.clock = options.clock ?? systemClock;
	}

	/** Quota for a member from the cached report of its provider. */
	quota = (member: Pick<Member, "provider" | "id">): Quota | undefined => {
		const entry = this.reports.get(member.provider);
		return entry ? quotaFromReport(entry.report, member.id) : undefined;
	};

	/** Marks every report stale, for `usage:changed:v1`. */
	invalidate(): void {
		for (const entry of this.reports.values()) entry.validUntil = 0;
		this.backoff.clear();
	}

	/** Refreshes stale reports for `providers`; resolves when they have settled. */
	refreshFor(providers: Iterable<string>): Promise<void> {
		const work: Promise<void>[] = [];
		const now = this.clock.now();
		for (const provider of new Set(providers)) {
			const entry = this.reports.get(provider);
			if (entry && entry.validUntil > now) continue;
			if ((this.backoff.get(provider) ?? 0) > now) continue;
			const running = this.inFlight.get(provider);
			if (running) {
				work.push(running);
				continue;
			}
			const task = this.fetch(provider).finally(() => this.inFlight.delete(provider));
			this.inFlight.set(provider, task);
			work.push(task);
		}
		return Promise.all(work).then(() => undefined);
	}

	private async fetch(provider: string): Promise<void> {
		const session = this.options.session();
		const now = this.clock.now();
		if (!session) return;
		const outcome = await queryUsage({
			events: this.options.events,
			session: session.sessionManager,
			sessionId: session.sessionId,
			providerId: provider,
			refresh: true,
			...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
		});
		if (outcome.status === "ready") {
			const ttl = this.options.ttlMs ?? 5 * 60_000;
			this.reports.set(provider, { report: outcome.report, validUntil: Math.min(now + ttl, outcome.expiresAt > now ? outcome.expiresAt : now + ttl) });
			this.backoff.delete(provider);
			return;
		}
		// No service, an unsupported provider or a failed read: stop asking for a while.
		this.backoff.set(provider, now + (outcome.status === "no-service" ? 10 * 60_000 : 2 * 60_000));
	}
}

/** Providers whose members are chosen by a quota strategy, so their usage is worth reading. */
export function quotaProviders(
	profiles: ReadonlyArray<{ tiers: ReadonlyArray<{ strategy: { name: string }; members: ReadonlyArray<{ provider: string; enabled: boolean }> }> }>,
): string[] {
	const out = new Set<string>();
	for (const profile of profiles) {
		for (const tier of profile.tiers) {
			if (tier.strategy.name !== "quota-headroom" && tier.strategy.name !== "soonest-reset") continue;
			for (const member of tier.members) if (member.enabled) out.add(member.provider);
		}
	}
	return [...out];
}
