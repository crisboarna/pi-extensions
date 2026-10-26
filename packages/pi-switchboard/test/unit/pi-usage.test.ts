import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeConfig } from "../../src/config/normalize.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { type EventsLike, queryUsage, quotaFromReport, quotaProviders, UsageCache, type UsageReport } from "../../src/selection/pi-usage.ts";
import { selectMember } from "../../src/selection/select.ts";
import { seededRng } from "../../src/util/runtime.ts";
import { keepEventLoopAlive } from "../support/keep-alive.ts";

keepEventLoopAlive();

const SESSION = { id: "s1" };

/** A usage service implementing usage-v1: it offers a (possibly pending) result during dispatch. */
function service(
	handler: (request: { providerId?: string; refresh?: boolean; signal: AbortSignal; sessionId: string }) => unknown,
): EventsLike & { calls: number } {
	const bus = {
		calls: 0,
		emit(channel: string, data: unknown) {
			if (channel !== "usage:query:v1") return;
			const request = data as { sessionId: string; respond(result: unknown): boolean; providerId?: string; refresh?: boolean; signal: AbortSignal };
			if (request.sessionId !== SESSION.id) return;
			bus.calls++;
			request.respond(handler(request));
		},
	};
	return bus;
}

const NOW = Date.UTC(2026, 9, 26, 12);
const ready = (buckets: unknown[], expiresAt = NOW + 600_000) => ({
	status: "ready",
	providerId: "acme",
	source: "refresh",
	expiresAt,
	report: { providerId: "acme", capturedAt: NOW, buckets },
});

const opts = (events: EventsLike, over: Partial<Parameters<typeof queryUsage>[0]> = {}): Parameters<typeof queryUsage>[0] => ({
	events,
	session: SESSION,
	sessionId: SESSION.id,
	providerId: "acme",
	refresh: true,
	timeoutMs: 200,
	...over,
});

describe("usage:query:v1 client", () => {
	it("returns a ready report from a pending promise and validates the request it sends", async () => {
		let seen: { providerId?: string; refresh?: boolean } = {};
		const bus = service((request) => {
			seen = request;
			return new Promise((resolve) =>
				setTimeout(() => resolve(ready([{ id: "w", label: "5h", unit: "percent", remaining: 40, resetsAt: NOW + 3_600_000 }])), 10),
			);
		});
		const outcome = await queryUsage(opts(bus));
		assert.equal(outcome.status, "ready");
		assert.deepEqual([seen.providerId, seen.refresh], ["acme", true]);
	});

	it("reports no service when nothing answers, and unavailable reasons from the service", async () => {
		assert.deepEqual(await queryUsage(opts({ emit: () => {} })), { status: "no-service" });
		assert.deepEqual(await queryUsage(opts(service(() => ({ status: "unavailable", reason: "cache-miss" })))), {
			status: "unavailable",
			reason: "cache-miss",
		});
	});

	it("ignores a service answering another session", async () => {
		assert.deepEqual(
			await queryUsage(
				opts(
					service(() => ready([])),
					{ sessionId: "other" },
				),
			),
			{ status: "no-service" },
		);
	});

	it("treats malformed results and rejections as protocol errors", async () => {
		assert.equal((await queryUsage(opts(service(() => "nonsense")))).status, "protocol-error");
		assert.equal((await queryUsage(opts(service(() => Promise.reject(new Error("boom")))))).status, "protocol-error");
	});

	it("aborts the request and returns timeout when the service is too slow", async () => {
		let aborted = false;
		const bus = service((request) => {
			request.signal.addEventListener("abort", () => {
				aborted = true;
			});
			return new Promise(() => {});
		});
		assert.deepEqual(await queryUsage(opts(bus, { timeoutMs: 20 })), { status: "timeout" });
		assert.equal(aborted, true);
	});

	it("returns cancelled without dispatching when the caller already aborted", async () => {
		const bus = service(() => ready([]));
		const controller = new AbortController();
		controller.abort();
		assert.deepEqual(await queryUsage(opts(bus, { signal: controller.signal })), { status: "cancelled" });
		assert.equal(bus.calls, 0);
	});
});

describe("quota from a report", () => {
	const report = (buckets: UsageReport["buckets"]): UsageReport => ({ providerId: "acme", capturedAt: NOW, buckets });

	it("takes the tightest bucket that applies to the model", () => {
		const r = report([
			{ id: "five-hour", label: "5h", unit: "percent", used: 70, resetsAt: NOW + 3_600_000 },
			{ id: "weekly", label: "week", unit: "percent", remaining: 90, resetsAt: NOW + 86_400_000 },
			{ id: "only-big", label: "big", unit: "percent", remaining: 5, modelKeys: ["big"] },
		]);
		assert.deepEqual(quotaFromReport(r, "mid"), { remaining: 0.3, resetsAt: NOW + 3_600_000, source: "pi-usage" });
		assert.equal(quotaFromReport(r, "big")?.remaining, 0.05);
	});

	it("computes shares from limits in other units and ignores unknown measurements", () => {
		const r = report([
			{ id: "spend", label: "spend", unit: "usd", used: 15, limit: 60 },
			{ id: "unknown", label: "x", unit: "count" },
			{ id: "nolimit", label: "y", unit: "usd", used: 3 },
		]);
		assert.equal(quotaFromReport(r, "m")?.remaining, 0.75);
		assert.equal(quotaFromReport(report([]), "m"), undefined, "no buckets means no quota (a Business account reports none)");
		assert.equal(quotaFromReport(report([{ id: "a", label: "a", unit: "percent", used: 140 }]), "m")?.remaining, 0, "clamped at zero");
	});
});

describe("usage cache", () => {
	const session = () => ({ sessionManager: SESSION, sessionId: SESSION.id });

	it("refreshes in the background, serves quota synchronously, and honours the ttl", async () => {
		let now = NOW;
		const bus = service(() => ready([{ id: "w", label: "w", unit: "percent", remaining: 25 }], now + 60_000));
		const cache = new UsageCache({ events: bus, session, clock: { now: () => now }, timeoutMs: 200 });
		assert.equal(cache.quota({ provider: "acme", id: "mid" }), undefined, "nothing cached yet");
		await cache.refreshFor(["acme", "acme"]);
		assert.equal(bus.calls, 1, "duplicates are asked once");
		assert.equal(cache.quota({ provider: "acme", id: "mid" })?.remaining, 0.25);
		await cache.refreshFor(["acme"]);
		assert.equal(bus.calls, 1, "a fresh report is not asked again");
		now += 61_000;
		await cache.refreshFor(["acme"]);
		assert.equal(bus.calls, 2, "refreshed once the service's expiry passes");
		cache.invalidate();
		await cache.refreshFor(["acme"]);
		assert.equal(bus.calls, 3, "usage:changed:v1 forces a refresh");
	});

	it("backs off when there is no service or the read fails", async () => {
		let now = NOW;
		const none = new UsageCache({ events: { emit: () => {} }, session, clock: { now: () => now }, timeoutMs: 50 });
		await none.refreshFor(["acme"]);
		await none.refreshFor(["acme"]);
		const failing = service(() => ({ status: "unavailable", reason: "query-failed" }));
		const cache = new UsageCache({ events: failing, session, clock: { now: () => now }, timeoutMs: 50 });
		await cache.refreshFor(["acme"]);
		await cache.refreshFor(["acme"]);
		assert.equal(failing.calls, 1, "a failed read is not retried at once");
		now += 3 * 60_000;
		await cache.refreshFor(["acme"]);
		assert.equal(failing.calls, 2);
	});

	it("does nothing without a session", async () => {
		const bus = service(() => ready([]));
		await new UsageCache({ events: bus, session: () => undefined }).refreshFor(["acme"]);
		assert.equal(bus.calls, 0);
	});
});

describe("quota strategies with pi-usage data", () => {
	const config = normalizeConfig({
		profiles: {
			p: { tiers: { t: { rank: 1, members: ["acme/x", "zen/y", "acme-2/z"], strategy: "quota-headroom" }, u: { rank: 2, members: ["acme/q"] } } },
		},
	});

	it("finds the providers a quota strategy needs", () => {
		assert.deepEqual(quotaProviders(Object.values(config.profiles)).sort(), ["acme", "acme-2", "zen"]);
		assert.deepEqual(quotaProviders([]), []);
	});

	it("picks the member with the most quota left, and falls back when no data exists", async () => {
		const bus = service((request) => ready([{ id: "w", label: "w", unit: "percent", remaining: request.providerId === "zen" ? 80 : 20 }]));
		const cache = new UsageCache({ events: bus, session: () => ({ sessionManager: SESSION, sessionId: SESSION.id }), timeoutMs: 100 });
		const tier = config.profiles.p?.tiers[0];
		assert.ok(tier);
		const base = {
			tier,
			tierKey: "p/t",
			store: new MemoryHealthStore(),
			now: NOW,
			rng: seededRng(1),
			task: 0,
			quota: (m: { provider: string; id: string }) => cache.quota(m),
		} as never;
		const before = selectMember(base);
		assert.ok(before.ok && before.metricFallback, "no data yet: the strategy's fallback chooses");
		await cache.refreshFor(quotaProviders(Object.values(config.profiles)));
		const after = selectMember(base);
		assert.ok(after.ok && after.member.key === "zen/y" && !after.metricFallback);
	});
});
