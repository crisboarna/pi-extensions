import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Member, StrategyName, StrategySpec } from "../../src/config/types.ts";
import { emptyHealth } from "../../src/selection/health.ts";
import { type Candidate, type CustomSelect, inSchedule, loadCustomStrategy, pickMember, type StrategyContext } from "../../src/selection/strategies.ts";

const member = (key: string, index: number, extra: Partial<Member> = {}): Member => {
	const [provider = "", id = ""] = key.split("/");
	return { key, provider, id, weight: 1, enabled: true, tags: [], index, ...extra };
};
const candidate = (key: string, index: number, extra: Partial<Candidate> = {}, memberExtra: Partial<Member> = {}): Candidate => ({
	member: member(key, index, memberExtra),
	inFlight: 0,
	latencySamples: 0,
	...extra,
});
const spec = (name: StrategyName, fallback: StrategyName = "ordered"): StrategySpec => ({ name, granularity: "request", fallback });
const context = (extra: Partial<StrategyContext> = {}): StrategyContext => ({
	tierKey: "p/t",
	now: Date.UTC(2026, 9, 26, 12, 0),
	rng: { next: () => 0.5 },
	data: emptyHealth(),
	degraded: false,
	...extra,
});
const pick = (candidates: Candidate[], name: StrategyName, extra: Partial<StrategyContext> = {}, fallback: StrategyName = "ordered") =>
	pickMember(candidates, spec(name, fallback), context(extra));
const two = () => [candidate("a/x", 0), candidate("b/y", 1)];

describe("pickMember", () => {
	it("returns nothing without candidates and the only candidate when there is one", () => {
		assert.equal(pick([], "ordered"), undefined);
		assert.equal(pick([candidate("a/x", 0)], "cheapest")?.why, "only eligible member");
	});

	it("sticky keeps the previous member, else takes the first", () => {
		assert.equal(pick(two(), "sticky", { previous: "b/y" })?.member.key, "b/y");
		const fresh = pick(two(), "sticky");
		assert.equal(fresh?.member.key, "a/x");
		assert.match(fresh?.why ?? "", /no previous member/);
	});

	it("round robin moves on from the stored pointer and starts at a random offset when degraded", () => {
		const data = emptyHealth();
		assert.equal(pick(two(), "round-robin", { data })?.member.key, "a/x");
		assert.equal(pick(two(), "round-robin", { data })?.member.key, "b/y");
		assert.equal(pick(two(), "round-robin", { data })?.member.key, "a/x");
		const degraded = pick(two(), "round-robin", { degraded: true, rng: { next: () => 0.0001 } });
		assert.match(degraded?.why ?? "", /round robin: next after position/);
	});

	it("weighted spreads picks in proportion to weight", () => {
		const data = emptyHealth();
		const candidates = [candidate("a/x", 0, {}, { weight: 3 }), candidate("b/y", 1)];
		const keys = Array.from({ length: 8 }, () => pick(candidates, "weighted", { data })?.member.key);
		assert.equal(keys.filter((key) => key === "a/x").length, 6);
		assert.match(pick(candidates, "weighted", { data })?.why ?? "", /weight \d of 4/);
	});

	it("random rolls by weight", () => {
		assert.equal(pick(two(), "random", { rng: { next: () => 0.1 } })?.member.key, "a/x");
		assert.equal(pick(two(), "random", { rng: { next: () => 0.9 } })?.member.key, "b/y");
	});

	it("least recently used prefers a never-used member, then the oldest", () => {
		const never = pick([candidate("a/x", 0, { lastUsedAt: 5 }), candidate("b/y", 1)], "least-recently-used");
		assert.equal(never?.why, "least recently used (never used)");
		const oldest = pick([candidate("a/x", 0, { lastUsedAt: 5 }), candidate("b/y", 1, { lastUsedAt: 2 })], "least-recently-used");
		assert.deepEqual([oldest?.member.key, oldest?.why], ["b/y", "least recently used"]);
	});

	it("least in flight picks the idlest member", () => {
		assert.equal(pick([candidate("a/x", 0, { inFlight: 2 }), candidate("b/y", 1, { inFlight: 0 })], "least-in-flight")?.member.key, "b/y");
	});

	it("metric strategies rank members that have the metric and fall back when none has it", () => {
		const quota = pick([candidate("a/x", 0), candidate("b/y", 1, { quota: { remaining: 0.4, source: "pi-usage" } })], "quota-headroom");
		assert.equal(quota?.member.key, "b/y");
		const cheap = pick([candidate("a/x", 0, { price: 9 }), candidate("b/y", 1, { price: 2 })], "cheapest");
		assert.match(cheap?.why ?? "", /cheapest by catalog price \(2\)/);
		const large = pick([candidate("a/x", 0, { contextWindow: 1000 }), candidate("b/y", 1, { contextWindow: 500 })], "largest-context");
		assert.equal(large?.member.key, "a/x");
		const missing = pick(two(), "cheapest", {}, "least-in-flight");
		assert.equal(missing?.metricFallback, "cheapest metric unavailable; used least-in-flight");
	});

	it("soonest reset skips nearly exhausted quotas", () => {
		const candidates = [
			candidate("a/x", 0, { quota: { remaining: 0.01, resetsAt: 10, source: "s" } }),
			candidate("b/y", 1, { quota: { remaining: 0.5, resetsAt: 50, source: "s" } }),
			candidate("c/z", 2, { quota: { remaining: 0.5, resetsAt: 20, source: "s" } }),
		];
		assert.equal(pick(candidates, "soonest-reset")?.member.key, "c/z");
		assert.ok(pick(two(), "soonest-reset")?.metricFallback);
	});

	it("fastest needs three latency samples per member", () => {
		const few = pick([candidate("a/x", 0, { latencySamples: 1, latencyEwma: 5 }), candidate("b/y", 1, { latencySamples: 5, latencyEwma: 2 })], "fastest");
		assert.match(few?.metricFallback ?? "", /fastest metric unavailable/);
		const enough = pick([candidate("a/x", 0, { latencySamples: 3, latencyEwma: 40.4 }), candidate("b/y", 1, { latencySamples: 3 })], "fastest");
		assert.deepEqual([enough?.member.key, enough?.why], ["a/x", "fastest first token (40 ms average)"]);
	});

	it("subscription-preferred narrows to subscription members when there are any", () => {
		const preferred = pick([candidate("a/x", 0), candidate("b/y", 1, { subscription: true })], "subscription-preferred");
		assert.deepEqual([preferred?.member.key, preferred?.why.startsWith("subscription member")], ["b/y", true]);
		assert.match(pick(two(), "subscription-preferred")?.why ?? "", /^no subscription member/);
	});

	it("scheduled narrows to members inside their time window", () => {
		const now = new Date(2026, 9, 26, 10, 30).getTime();
		const inside = pick(
			[candidate("a/x", 0, {}, { schedule: [{ from: "18:00", to: "20:00" }] }), candidate("b/y", 1, {}, { schedule: [{ from: "09:00", to: "11:00" }] })],
			"scheduled",
			{ now },
		);
		assert.deepEqual([inside?.member.key, inside?.why.startsWith("in its time window")], ["b/y", true]);
		const none = pick([candidate("a/x", 0, {}, { schedule: [{ from: "18:00", to: "20:00" }] }), candidate("b/y", 1)], "scheduled", {
			now: new Date(2026, 9, 26, 21, 0).getTime(),
		});
		assert.equal(none?.member.key, "b/y");
		const outside = pick(
			[candidate("a/x", 0, {}, { schedule: [{ from: "18:00", to: "20:00" }] }), candidate("b/y", 1, {}, { schedule: [{ from: "01:00", to: "02:00" }] })],
			"scheduled",
			{ now },
		);
		assert.match(outside?.why ?? "", /^no member in its time window/);
	});

	it("custom uses the module's choice and falls back when it fails or chooses nothing", () => {
		const choose: CustomSelect = (members, ctx) => (ctx.previous ? members[1]?.member.key : members[0]?.member.key);
		assert.equal(pick(two(), "custom", { custom: choose, previous: "a/x" })?.member.key, "b/y");
		assert.equal(pick(two(), "custom", { custom: choose })?.why, "custom strategy");
		assert.match(pick(two(), "custom", { custom: () => "nobody" })?.metricFallback ?? "", /chose no eligible member/);
		assert.match(pick(two(), "custom")?.metricFallback ?? "", /custom strategy not loaded/);
		const throws: CustomSelect = () => {
			throw new Error("boom");
		};
		assert.match(pick(two(), "custom", { custom: throws })?.metricFallback ?? "", /custom strategy failed: boom/);
		const throwsString: CustomSelect = () => {
			throw "bad";
		};
		assert.match(pick(two(), "custom", { custom: throwsString })?.metricFallback ?? "", /custom strategy failed: bad/);
	});

	it("a fallback that is not a plain strategy falls back to list order", () => {
		const result = pick(two(), "cheapest", {}, "subscription-preferred");
		assert.deepEqual([result?.member.key, result?.metricFallback], ["a/x", "cheapest metric unavailable; used subscription-preferred"]);
	});
});

describe("inSchedule", () => {
	// 2026-10-26 is a Monday.
	const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, 26 + day, hour, minute).getTime();
	it("matches day lists, ranges, wrapping ranges and daily", () => {
		assert.equal(inSchedule(undefined, at(0, 3)), true);
		assert.equal(inSchedule([], at(0, 3)), true);
		assert.equal(inSchedule([{ days: "daily", from: "00:00", to: "23:59" }], at(0, 3)), true);
		assert.equal(inSchedule([{ days: "mon-fri", from: "09:00", to: "17:00" }], at(0, 10)), true);
		assert.equal(inSchedule([{ days: "mon-fri", from: "09:00", to: "17:00" }], at(5, 10)), false);
		assert.equal(inSchedule([{ days: "sat, sun", from: "09:00", to: "17:00" }], at(6, 10)), true);
		assert.equal(inSchedule([{ days: "fri-mon", from: "09:00", to: "17:00" }], at(0, 10)), true);
		assert.equal(inSchedule([{ days: "fri-mon", from: "09:00", to: "17:00" }], at(2, 10)), false);
		assert.equal(inSchedule([{ days: "someday", from: "09:00", to: "17:00" }], at(0, 10)), false);
	});

	it("handles windows that cross midnight and times without minutes", () => {
		assert.equal(inSchedule([{ from: "22:00", to: "06:00" }], at(0, 23)), true);
		assert.equal(inSchedule([{ from: "22:00", to: "06:00" }], at(0, 5)), true);
		assert.equal(inSchedule([{ from: "22:00", to: "06:00" }], at(0, 12)), false);
		assert.equal(inSchedule([{ from: "9", to: "10" }], at(0, 9, 30)), true);
	});
});

describe("loadCustomStrategy", () => {
	const dir = mkdtempSync(join(tmpdir(), "switchboard-custom-"));
	it("loads a select export, a default export, and a path under the home directory", async () => {
		writeFileSync(join(dir, "named.mjs"), "export function select(members) { return members[0].member.key; }\n");
		writeFileSync(join(dir, "default.mjs"), "export default function (members) { return members[1].member.key; }\n");
		const named = await loadCustomStrategy(join(dir, "named.mjs"), "/nowhere");
		assert.equal(named(two(), { tierKey: "k", now: 0 }), "a/x");
		const fromHome = await loadCustomStrategy("~/default.mjs", dir);
		assert.equal(fromHome(two(), { tierKey: "k", now: 0 }), "b/y");
	});

	it("rejects a module without a select function", async () => {
		writeFileSync(join(dir, "empty.mjs"), "export const select = 3;\n");
		await assert.rejects(loadCustomStrategy(join(dir, "empty.mjs"), dir), /exports no select function/);
	});
});
