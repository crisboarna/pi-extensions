import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type EventsLike, parseResult, queryUsage, quotaFromReport, UsageCache, type UsageReport } from "../../src/selection/pi-usage.ts";

const SESSION = { id: "s1" };
const answering = (result: (signal: AbortSignal) => unknown): EventsLike => ({
	emit(_channel: string, data: unknown) {
		const request = data as { respond(value: unknown): boolean; signal: AbortSignal };
		request.respond(result(request.signal));
		assert.equal(request.respond("second"), false, "only the first offer counts");
	},
});
const query = (events: EventsLike, extra: Partial<Parameters<typeof queryUsage>[0]> = {}) =>
	queryUsage({ events, session: SESSION, sessionId: SESSION.id, providerId: "acme", refresh: true, timeoutMs: 100, ...extra });

describe("parseResult", () => {
	it("defaults missing fields and drops malformed buckets", () => {
		assert.deepEqual(parseResult({ status: "unavailable" }, "acme"), { status: "unavailable", reason: "unknown" });
		assert.deepEqual(parseResult({ status: "ready" }, "acme"), { status: "protocol-error" });
		const outcome = parseResult(
			{
				status: "ready",
				report: {
					buckets: [
						{ id: "a", unit: "tokens", used: 10, limit: 100, modelKeys: ["mid", 3] },
						{ id: "b" },
						"junk",
						{ id: "c", unit: "percent", label: "weekly", remaining: Number.NaN },
					],
				},
			},
			"acme",
		);
		assert.equal(outcome.status, "ready");
		if (outcome.status !== "ready") return;
		assert.deepEqual([outcome.expiresAt, outcome.report.providerId, outcome.report.capturedAt], [0, "acme", 0]);
		assert.deepEqual(outcome.report.buckets, [
			{ id: "a", label: "a", unit: "tokens", used: 10, limit: 100, modelKeys: ["mid"] },
			{ id: "c", label: "weekly", unit: "percent" },
		]);
		const noBuckets = parseResult({ status: "ready", report: { buckets: "x" } }, "acme");
		assert.deepEqual(noBuckets.status === "ready" ? noBuckets.report.buckets : undefined, []);
	});
});

describe("quotaFromReport", () => {
	it("uses used against limit, skips buckets without a limit, and clamps the share", () => {
		const report: UsageReport = {
			providerId: "acme",
			capturedAt: 0,
			buckets: [
				{ id: "a", label: "a", unit: "count", used: 30, limit: 100 },
				{ id: "b", label: "b", unit: "count", used: 5 },
				{ id: "c", label: "c", unit: "usd", remaining: 500, limit: 100 },
				{ id: "d", label: "d", unit: "percent" },
			],
		};
		assert.deepEqual(quotaFromReport(report, "mid"), { remaining: 0.7, source: "pi-usage" });
		assert.equal(quotaFromReport({ ...report, buckets: report.buckets.slice(1, 2) }, "mid"), undefined);
	});
});

describe("queryUsage", () => {
	it("returns cancelled when the caller aborts while waiting, and rejects a second offer", async () => {
		const controller = new AbortController();
		const pending = query(
			answering(() => new Promise(() => {})),
			{ signal: controller.signal, timeoutMs: 5_000 },
		);
		controller.abort();
		assert.deepEqual(await pending, { status: "cancelled" });
	});

	it("is a protocol error when the bus throws", async () => {
		const throwing: EventsLike = {
			emit: () => {
				throw new Error("bus down");
			},
		};
		assert.deepEqual(await query(throwing), { status: "protocol-error" });
	});
});

describe("UsageCache", () => {
	it("shares one in-flight request between overlapping refreshes and caps validity at its ttl", async () => {
		let release: (value: unknown) => void = () => {};
		let calls = 0;
		const events: EventsLike = {
			emit(_channel: string, data: unknown) {
				calls++;
				(data as { respond(value: unknown): boolean }).respond(
					new Promise((resolve) => {
						release = resolve;
					}),
				);
			},
		};
		let now = 1_000;
		const cache = new UsageCache({ events, session: () => ({ sessionManager: SESSION, sessionId: SESSION.id }), clock: { now: () => now }, ttlMs: 50 });
		const first = cache.refreshFor(["acme"]);
		const second = cache.refreshFor(["acme"]);
		release({ status: "ready", expiresAt: 0, report: { providerId: "acme", capturedAt: 0, buckets: [{ id: "w", unit: "percent", remaining: 40 }] } });
		await Promise.all([first, second]);
		assert.equal(calls, 1);
		assert.equal(cache.quota({ provider: "acme", id: "x" })?.remaining, 0.4);
		now += 51;
		void cache.refreshFor(["acme"]);
		assert.equal(calls, 2, "past the ttl the report is refreshed");
	});
});
