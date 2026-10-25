import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Member, StrategyName, StrategySpec, Tier } from "../../src/config/types.ts";
import { classifyError, parseRetryAt, parseRetryHeaders } from "../../src/selection/errors.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { ledgerQuota, type UsageEntry } from "../../src/selection/ledger.ts";
import { borrowOrder, cooldownKey, DEFAULT_FAILURE_CONFIG, recordFailure, recordSuccess, acquireLease, releaseLease, selectMember, type SelectInput } from "../../src/selection/select.ts";
import { inSchedule, loadCustomStrategy } from "../../src/selection/strategies.ts";
import { seededRng } from "../../src/util/runtime.ts";

const member = (key: string, index: number, extra: Partial<Member> = {}): Member => {
	const [provider = "", id = ""] = key.split("/");
	return { key, provider, id, weight: 1, enabled: true, tags: [], index, ...extra };
};

const tierOf = (members: Member[], strategy: StrategyName | Partial<StrategySpec>, extra: Partial<Tier> = {}): Tier => ({
	name: "t",
	rank: 1,
	members,
	strategy: { granularity: "request", fallback: "ordered", ...(typeof strategy === "string" ? { name: strategy } : strategy) } as StrategySpec,
	cooldown: { scope: "member" },
	...extra,
});

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function picks(tier: Tier, n: number, options: Partial<SelectInput> = {}): string[] {
	const store = options.store ?? new MemoryHealthStore();
	const rng = options.rng ?? seededRng(42);
	const out: string[] = [];
	let previous: SelectInput["previous"];
	for (let i = 0; i < n; i++) {
		const result = selectMember({ tier, tierKey: "p/t", store, now: NOW + i * 1000, rng, task: i, ...(previous ? { previous } : {}), ...options });
		assert.ok(result.ok, "selection succeeded");
		if (!result.ok) break;
		out.push(result.member.key);
		previous = { key: result.member.key, task: i, chosenAt: NOW + i * 1000 };
	}
	return out;
}

const count = (keys: string[]) => keys.reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {});

describe("strategies", () => {
	const three = [member("a/x", 0), member("b/y", 1), member("c/z", 2)];

	it("ordered always picks the first healthy member", () => {
		assert.deepEqual(count(picks(tierOf(three, "ordered"), 5)), { "a/x": 5 });
	});

	it("round-robin rotates evenly across providers", () => {
		assert.deepEqual(picks(tierOf(three, "round-robin"), 6), ["a/x", "b/y", "c/z", "a/x", "b/y", "c/z"]);
	});

	it("weighted spreads in proportion to weight", () => {
		const tier = tierOf([member("a/x", 0, { weight: 3 }), member("b/y", 1, { weight: 1 })], "weighted");
		assert.deepEqual(count(picks(tier, 400)), { "a/x": 300, "b/y": 100 });
	});

	it("random is seedable and roughly uniform", () => {
		const a = picks(tierOf(three, "random"), 300, { rng: seededRng(7) });
		assert.deepEqual(a, picks(tierOf(three, "random"), 300, { rng: seededRng(7) }));
		for (const n of Object.values(count(a))) assert.ok(n > 70 && n < 130, `count ${n}`);
	});

	it("least-recently-used cycles through members", () => {
		assert.deepEqual(picks(tierOf(three, "least-recently-used"), 4), ["a/x", "b/y", "c/z", "a/x"]);
	});

	it("least-in-flight avoids busy members", () => {
		const store = new MemoryHealthStore();
		acquireLease(store, "a/x", "l1", NOW, 60_000);
		assert.equal(picks(tierOf(three, "least-in-flight"), 1, { store })[0], "b/y");
	});

	it("cheapest and largest-context use catalog data and fall back when it is missing", () => {
		const info = (m: Member) => ({ "a/x": { price: 10, contextWindow: 100 }, "b/y": { price: 2, contextWindow: 400 }, "c/z": {} })[m.key] ?? {};
		assert.equal(picks(tierOf(three, "cheapest"), 1, { info })[0], "b/y");
		assert.equal(picks(tierOf(three, "largest-context"), 1, { info })[0], "b/y");
		const none = selectMember({ tier: tierOf(three, "cheapest"), tierKey: "p/t", store: new MemoryHealthStore(), now: NOW, rng: seededRng(1), task: 0 });
		assert.ok(none.ok && none.metricFallback?.includes("cheapest metric unavailable"));
	});

	it("fastest explores until each member has three samples", () => {
		const store = new MemoryHealthStore();
		for (const [key, ms] of [["a/x", 900], ["b/y", 200], ["c/z", 500]] as const) for (let i = 0; i < 3; i++) recordSuccess(store, `x:${key}`, key, ms);
		assert.equal(picks(tierOf(three, "fastest"), 1, { store })[0], "b/y");
		const fresh = selectMember({ tier: tierOf(three, "fastest"), tierKey: "p/t", store: new MemoryHealthStore(), now: NOW, rng: seededRng(1), task: 0 });
		assert.ok(fresh.ok && fresh.metricFallback);
	});

	it("quota-headroom and soonest-reset use quota data and fall back without it", () => {
		const quota = (m: Member) =>
			({ "a/x": { remaining: 0.2, resetsAt: NOW + 3_600_000, source: "test" }, "b/y": { remaining: 0.9, resetsAt: NOW + 7_200_000, source: "test" } })[m.key];
		assert.equal(picks(tierOf(three, "quota-headroom"), 1, { quota })[0], "b/y");
		assert.equal(picks(tierOf(three, "soonest-reset"), 1, { quota })[0], "a/x");
		const missing = selectMember({ tier: tierOf(three, "quota-headroom"), tierKey: "p/t", store: new MemoryHealthStore(), now: NOW, rng: seededRng(1), task: 0 });
		assert.ok(missing.ok && missing.member.key === "a/x" && missing.metricFallback);
	});

	it("subscription-preferred picks subscription members first", () => {
		const info = (m: Member) => ({ subscription: m.key === "c/z" });
		assert.equal(picks(tierOf(three, "subscription-preferred"), 1, { info })[0], "c/z");
	});

	it("scheduled prefers members inside their window", () => {
		const day = new Date(NOW);
		const hour = String(day.getHours()).padStart(2, "0");
		const next = String((day.getHours() + 1) % 24).padStart(2, "0");
		const tier = tierOf([member("a/x", 0, { schedule: [{ from: "00:00", to: "00:01", days: "daily" }] }), member("b/y", 1, { schedule: [{ from: `${hour}:00`, to: `${next}:00` }] })], "scheduled");
		assert.equal(picks(tier, 1)[0], "b/y");
		assert.ok(inSchedule([{ from: "22:00", to: "02:00" }], new Date(2026, 0, 1, 23, 30).getTime()), "windows wrap midnight");
	});

	it("custom loads a user module and falls back when it fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-custom-"));
		const file = join(dir, "pick-last.mjs");
		writeFileSync(file, "export function select(members) { return members.at(-1).member.key; }\n");
		const custom = await loadCustomStrategy(file, "/home/none");
		assert.equal(picks(tierOf(three, { name: "custom", module: file }), 1, { custom })[0], "c/z");
		const broken = () => {
			throw new Error("boom");
		};
		const result = selectMember({ tier: tierOf(three, { name: "custom" }), tierKey: "p/t", store: new MemoryHealthStore(), now: NOW, rng: seededRng(1), task: 0, custom: broken });
		assert.ok(result.ok && result.metricFallback?.includes("custom strategy failed: boom"));
	});
});

describe("granularity and affinity", () => {
	const two = [member("a/x", 0), member("b/y", 1)];

	it("session granularity keeps the healthy previous member", () => {
		assert.deepEqual(picks(tierOf(two, { name: "round-robin", granularity: "session" }), 4), ["a/x", "a/x", "a/x", "a/x"]);
	});

	it("task granularity re-picks on each new task", () => {
		const tier = tierOf(two, { name: "round-robin", granularity: "task" });
		const store = new MemoryHealthStore();
		const first = selectMember({ tier, tierKey: "p/t", store, now: NOW, rng: seededRng(1), task: 1 });
		assert.ok(first.ok);
		const sameTask = selectMember({ tier, tierKey: "p/t", store, now: NOW, rng: seededRng(1), task: 1, previous: { key: first.member.key, task: 1, chosenAt: NOW } });
		assert.ok(sameTask.ok && sameTask.kept);
		const nextTask = selectMember({ tier, tierKey: "p/t", store, now: NOW, rng: seededRng(1), task: 2, previous: { key: first.member.key, task: 1, chosenAt: NOW } });
		assert.ok(nextTask.ok && !nextTask.kept && nextTask.member.key === "b/y");
	});

	it("request granularity re-picks every time", () => {
		assert.deepEqual(picks(tierOf(two, { name: "round-robin", granularity: "request" }), 3), ["a/x", "b/y", "a/x"]);
	});

	it("affinity keeps a member until its TTL expires", () => {
		const tier = tierOf(two, "round-robin", { affinity: { scope: "session", ttlMs: 5_000 } });
		const store = new MemoryHealthStore();
		const base = { tier, tierKey: "p/t", store, rng: seededRng(1), task: 0 };
		const kept = selectMember({ ...base, now: NOW + 4_000, previous: { key: "a/x", task: 0, chosenAt: NOW } });
		assert.ok(kept.ok && kept.kept && kept.member.key === "a/x");
		const expired = selectMember({ ...base, now: NOW + 6_000, previous: { key: "a/x", task: 0, chosenAt: NOW } });
		assert.ok(expired.ok && !expired.kept);
	});

	it("force re-picks even when granularity would keep", () => {
		const tier = tierOf(two, { name: "ordered", granularity: "session" });
		const result = selectMember({ tier, tierKey: "p/t", store: new MemoryHealthStore(), now: NOW, rng: seededRng(1), task: 0, previous: { key: "a/x", task: 0, chosenAt: NOW }, exclude: ["a/x"], force: true });
		assert.ok(result.ok && result.member.key === "b/y");
	});
});

describe("cooldown and failure handling", () => {
	const two = [member("a/x", 0), member("b/y", 1)];
	const tier = tierOf(two, "ordered");

	it("benches until the provider's retry time and skips the member meanwhile", () => {
		const store = new MemoryHealthStore();
		const key = cooldownKey("p/t", tier, two[0] as Member);
		const outcome = recordFailure(store, key, "rate-limit", NOW + 20_000, NOW);
		assert.equal(outcome.switchMember, true);
		assert.equal(outcome.benchedUntil, NOW + 20_000);
		const during = selectMember({ tier, tierKey: "p/t", store, now: NOW + 10_000, rng: seededRng(1), task: 0 });
		assert.ok(during.ok && during.member.key === "b/y");
		assert.match(during.ok ? (during.candidates[0]?.excluded ?? "") : "", /cooling down \(rate limit\)/u);
		const after = selectMember({ tier, tierKey: "p/t", store, now: NOW + 21_000, rng: seededRng(1), task: 0 });
		assert.ok(after.ok && after.member.key === "a/x");
	});

	it("uses default bench times when the provider gives none", () => {
		const store = new MemoryHealthStore();
		assert.equal(recordFailure(store, "k1", "rate-limit", undefined, NOW).benchedUntil, NOW + DEFAULT_FAILURE_CONFIG.defaultCooldownMs);
		assert.equal(recordFailure(store, "k2", "quota", undefined, NOW).benchedUntil, NOW + DEFAULT_FAILURE_CONFIG.quotaBenchMs);
	});

	it("does not bench on overload and switches after repeated overloads", () => {
		const store = new MemoryHealthStore();
		const first = recordFailure(store, "k", "overloaded", undefined, NOW);
		assert.deepEqual([first.switchMember, first.benchedUntil], [false, undefined]);
		assert.equal(recordFailure(store, "k", "overloaded", undefined, NOW).switchMember, true);
		recordSuccess(store, "k", "a/x", 100);
		assert.equal(recordFailure(store, "k", "overloaded", undefined, NOW).switchMember, false, "success resets the count");
	});

	it("allows a few server errors before benching", () => {
		const store = new MemoryHealthStore();
		assert.equal(recordFailure(store, "k", "server", undefined, NOW).switchMember, false);
		assert.equal(recordFailure(store, "k", "server", undefined, NOW + 1).switchMember, false);
		const third = recordFailure(store, "k", "server", undefined, NOW + 2);
		assert.equal(third.switchMember, true);
		assert.equal(third.benchedUntil, NOW + 2 + DEFAULT_FAILURE_CONFIG.serverBenchMs);
		assert.equal(recordFailure(store, "j", "server", undefined, NOW).switchMember, false);
		assert.equal(recordFailure(store, "j", "server", undefined, NOW + 61_000).switchMember, false, "old errors age out");
	});

	it("reports the earliest reset when every member is cooling down", () => {
		const store = new MemoryHealthStore();
		recordFailure(store, cooldownKey("p/t", tier, two[0] as Member), "quota", NOW + 90_000, NOW);
		recordFailure(store, cooldownKey("p/t", tier, two[1] as Member), "rate-limit", NOW + 30_000, NOW);
		const result = selectMember({ tier, tierKey: "p/t", store, now: NOW, rng: seededRng(1), task: 0 });
		assert.ok(!result.ok);
		assert.deepEqual(result.ok ? undefined : result.earliestReset, { member: "b/y", at: NOW + 30_000 });
	});

	it("shares a cooldown across tiers when scoped to the physical model", () => {
		const scoped = tierOf(two, "ordered", { cooldown: { scope: "provider-model-account" } });
		assert.equal(cooldownKey("p/one", scoped, two[0] as Member), cooldownKey("p/two", scoped, two[0] as Member));
		assert.notEqual(cooldownKey("p/one", tier, two[0] as Member), cooldownKey("p/two", tier, two[0] as Member));
	});

	it("respects max concurrency and releases leases", () => {
		const limited = tierOf([member("a/x", 0, { maxConcurrency: 1 }), member("b/y", 1)], "ordered");
		const store = new MemoryHealthStore();
		acquireLease(store, "a/x", "l1", NOW, 60_000);
		const busy = selectMember({ tier: limited, tierKey: "p/t", store, now: NOW, rng: seededRng(1), task: 0 });
		assert.ok(busy.ok && busy.member.key === "b/y");
		releaseLease(store, "a/x", "l1", NOW);
		const free = selectMember({ tier: limited, tierKey: "p/t", store, now: NOW, rng: seededRng(1), task: 0 });
		assert.ok(free.ok && free.member.key === "a/x");
	});

	it("borrows up first, then down, within bounds", () => {
		const tiers = ["a", "b", "c", "d"].map((name) => ({ name }));
		assert.deepEqual(borrowOrder(tiers, "b", ["up", "down"]), ["c", "d", "a"]);
		assert.deepEqual(borrowOrder(tiers, "b", ["down", "up"]), ["a", "c", "d"]);
		assert.deepEqual(borrowOrder(tiers, "b", ["up", "down"], { max: "c" }), ["c", "a"]);
	});
});

describe("error classification (real provider and pi-multi-pass strings)", () => {
	const cases: Array<[string, string]> = [
		["You have hit your ChatGPT usage limit (team plan). Try again in ~42 min.", "quota"],
		["429 You exceeded your current quota, please check your plan and billing details.", "quota"],
		['{"error":{"code":"insufficient_quota","message":"quota exceeded"}}', "quota"],
		["subscription_sharing_usage_limit_exceeded", "quota"],
		["Monthly usage limit reached", "quota"],
		["429 Rate limit reached for requests", "rate-limit"],
		["Too Many Requests", "rate-limit"],
		['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
		["The model is at capacity, please try again later", "overloaded"],
		["503 Service temporarily unavailable", "overloaded"],
		["prompt is too long: 210432 tokens > 200000 maximum", "context-overflow"],
		["This model's maximum context length is 128000 tokens", "context-overflow"],
		["401 Unauthorized", "auth"],
		["invalid_refresh_token: refresh token is invalid", "auth"],
		["500 Internal Server Error", "server"],
		["fetch failed: ECONNRESET", "server"],
		["Something odd happened", "other"],
	];
	for (const [message, expected] of cases) {
		it(`${expected}: ${message.slice(0, 50)}`, () => assert.equal(classifyError(message), expected));
	}

	it("honours user pattern overrides", () => {
		assert.equal(classifyError("weird vendor throttle", { "rate-limit": ["vendor throttle"] }), "rate-limit");
	});

	it("parses retry times from messages and headers", () => {
		assert.equal(parseRetryAt("Try again in ~42 min.", NOW), NOW + 42 * 60_000);
		assert.equal(parseRetryAt("please try again in 1m30s", NOW), NOW + 90_000);
		assert.equal(parseRetryAt("Retry-After: 20", NOW), NOW + 20_000);
		assert.equal(parseRetryAt("limit resets in 3h", NOW), NOW + 3 * 3_600_000);
		assert.equal(parseRetryAt('{"resets_at": 1793000000}', NOW), 1_793_000_000_000);
		assert.equal(parseRetryAt("resets_at=2026-10-25T13:00:00Z", NOW), Date.UTC(2026, 9, 25, 13));
		assert.equal(parseRetryAt("no hint here", NOW), undefined);
		assert.equal(parseRetryHeaders({ "Retry-After": "7" }, NOW), NOW + 7000);
		assert.equal(parseRetryHeaders({ "retry-after-ms": "250" }, NOW), NOW + 250);
		assert.equal(parseRetryHeaders({ "x-ratelimit-reset-requests": "2s" }, NOW), NOW + 2000);
	});
});

describe("ledger quota", () => {
	it("computes the remaining share of a member budget in the current window", () => {
		const m = member("a/x", 0, { budget: { window: "5h", tokens: 1000 } });
		const windowStart = Math.floor(NOW / (5 * 3_600_000)) * 5 * 3_600_000;
		const entry = (ts: number, tokens: number): UsageEntry => ({ ts: new Date(ts).toISOString(), session: "s", task: 1, provider: "a", model: "x", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		const quota = ledgerQuota([entry(windowStart + 1, 400), entry(windowStart - 1, 900)], m, NOW);
		assert.deepEqual(quota, { remaining: 0.6, resetsAt: windowStart + 5 * 3_600_000, source: "ledger" });
		assert.equal(ledgerQuota([], member("b/y", 1), NOW), undefined, "no budget, no quota");
	});
});
