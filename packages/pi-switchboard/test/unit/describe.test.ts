import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DebugLog } from "../../src/record/debug-log.ts";
import { explain, summarize } from "../../src/record/describe.ts";
import { footerText, footerValues } from "../../src/record/footer.ts";
import type { DecisionEntry } from "../../src/record/types.ts";

const minimal: DecisionEntry = {
	v: 1,
	id: "d_min",
	ts: "2026-10-26T09:00:00.000Z",
	task: 1,
	scope: "main",
	reason: "user",
	kind: "inactive",
	profile: { name: "", source: "default" },
	tier: { candidate: "", chosen: "", rank: 0, why: "no profile matches" },
	model: { provider: "", id: "", thinking: "" },
	switch: { cacheMiss: false },
};

const full: DecisionEntry = {
	...minimal,
	id: "d_full",
	scope: "subagent",
	reason: "retry",
	kind: "fallback",
	profile: { name: "work", source: "match" },
	virtualModel: "switchboard/auto",
	evidence: { digest: "abc", excerpt: "fix   the\nbuild", tokens: 900, truncated: true },
	classifier: {
		latencyMs: 2100,
		failure: "classifier-error",
		usage: { input: 120, output: 3, cost: 0 },
		attempts: [
			{ model: "local/a", ok: false, error: "timeout", latencyMs: 2000, cold: true },
			{ model: "local/b", ok: false, error: "refused", latencyMs: 100 },
		],
	},
	answers: {
		work: { type: "choice", choice: "plan", probabilities: {}, confidence: 0.4 },
		depth: { type: "score", score: 1.5, confidence: 0.2 },
		risky: { type: "bool", probability: 0.8 },
	},
	rules: {
		ruleset: "custom",
		matched: 0,
		gate: { referenced: ["work"], confidence: 0.4, threshold: 0.8, passed: false },
		floors: [
			{ index: 0, atLeast: "deep", confidence: 0.9, applied: true, raised: true },
			{ index: 1, atLeast: "mid", confidence: 0.9, applied: true, raised: false },
			{ index: 2, atLeast: "top", confidence: 0.1, applied: false, raised: false },
		],
	},
	tier: { candidate: "deep", chosen: "mid", previous: "light", rank: 2, why: "fallback tier", borrowedFrom: "deep" },
	selection: {
		strategy: "ordered",
		granularity: "task",
		why: "first",
		metricFallback: "cheapest metric unavailable; used ordered",
		kept: true,
		shared: false,
		candidates: [{ member: "acme/mid", eligible: true, inFlight: 2 }],
	},
	model: { provider: "acme", id: "mid", thinking: "high", account: "acme-2" },
	switch: { from: "acme/small", cacheMiss: true },
	error: { class: "rate-limit", message: "429", benchedUntil: "2026-10-26T10:00:00.000Z" },
	subagent: { agent: "scout", taskIndex: 2, toolCallId: "t1", mode: "skipped", skipped: "external runner" },
	budget: [{ scope: "session", metric: "costUsd", used: 1.234, limit: 5 }],
};

describe("summarize", () => {
	it("describes a decision with no tier by its reason", () => {
		assert.equal(summarize(minimal), "⇄ task 1 · inactive · no profile matches");
	});

	it("names the agent, the borrowed tier, the kind and a cache miss", () => {
		assert.equal(summarize(full), "⇄ task 1 · scout (not routed) · work=plan (0.40) · fallback · mid (borrowed) → mid:high · cache miss");
		const routed = summarize({
			...full,
			subagent: { agent: "scout", taskIndex: 2, toolCallId: "t1", mode: "child" },
			tier: { candidate: "deep", chosen: "mid", rank: 2, why: "fallback tier" },
			model: { ...full.model, thinking: "" },
			switch: { cacheMiss: false },
		});
		assert.equal(routed, "⇄ task 1 · scout · work=plan (0.40) · fallback · mid → mid");
	});

	it("shows the tier a dry-run request would have used next to the baseline that ran", () => {
		const { subagent: _subagent, ...main } = full;
		const dry = { ...main, kind: "dry-run" as const, switch: { cacheMiss: false } };
		const would = summarize({ ...dry, tier: { candidate: "light", chosen: "mid", rank: 2, why: "dry-run routes to the baseline tier" } });
		assert.equal(would, "⇄ task 1 · work=plan (0.40) · dry-run · would use light · mid → mid:high");
		const same = summarize({ ...dry, tier: { candidate: "mid", chosen: "mid", rank: 2, why: "dry-run routes to the baseline tier" } });
		assert.ok(!same.includes("would use"));
	});
});

describe("explain", () => {
	it("explains every part of a full decision", () => {
		const text = explain(full).join("\n");
		for (const expected of [
			"profile: work (match) via switchboard/auto",
			"evidence: 900 tokens, digest abc, truncated",
			"  request: fix the build",
			"classifier: none answered in 2100 ms (classifier-error), 120 tokens",
			"  ✗ local/a: timeout (cold)",
			"  ✗ local/b: refused",
			"answers: work=plan (0.40), depth=1.50, risky=0.80",
			"rules: custom rule 1; gate 0.40 vs 0.8 on [work] failed",
			"  floor 1: at least deep (raised)",
			"  floor 2: at least mid",
			"tier: deep → mid (was light): fallback tier",
			"selection: ordered/task: first [cheapest metric unavailable; used ordered] [health not shared]",
			"  ✓ acme/mid, 2 in flight",
			"model: acme/mid:high on account acme-2 (switch from acme/small, cache miss)",
			"error: rate-limit, benched until 2026-10-26T10:00:00.000Z: 429",
			"subagent: scout #2 skipped: external runner",
			"budget: session costUsd 1.23/5",
		])
			assert.ok(text.includes(expected), `missing: ${expected}\n${text}`);
		assert.ok(!text.includes("floor 3"));
	});

	it("says a catch-all rule has no confidence gate instead of an empty one", () => {
		const rules = { ...full.rules!, gate: { ...full.rules!.gate, referenced: [] } };
		const text = explain({ ...full, rules }).join("\n");
		assert.ok(text.includes("rules: custom rule 1; no confidence gate"), text);
		assert.ok(!text.includes("on []"));
	});

	it("keeps a minimal decision short", () => {
		const lines = explain({ ...minimal, error: { class: "auth", message: "no key" }, budget: [] });
		assert.deepEqual(lines.slice(1), ["profile: (none) (default)", "tier: - → -: no profile matches", "model: /:", "error: auth: no key"]);
	});
});

describe("footer", () => {
	it("has only the extra values without a decision, and markers with one", () => {
		assert.deepEqual(footerValues(undefined, { running: 2 }), { running: 2 });
		const values = footerValues(full, { switches: 3 });
		assert.deepEqual([values.tier, values.account, values.strategy, values.confidence, values.switches], ["mid↑", "acme-2", "ordered", "0.40", 3]);
		assert.equal(footerValues(minimal).account, undefined);
		assert.equal(footerText("{tier}", full, { pinned: "deep", dryRun: true }), "mid↑ · pinned deep · dry-run · fallback");
		assert.equal(footerText("{tier}", undefined, {}), undefined);
		assert.equal(footerText("{tier}", undefined, { pinned: "@top" }), "switchboard · pinned @top", "a pin shows before the first decision");
		assert.equal(footerText("{tier}", undefined, { dryRun: true }), "switchboard · dry-run");
		assert.equal(footerText("{tier}", full, { inactive: "no classifier" }), "switchboard inactive: no classifier");
	});
});

describe("DebugLog", () => {
	it("keeps full evidence only when asked, and never throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-debug-"));
		const path = join(dir, "decisions.jsonl");
		new DebugLog({ path, maxBytes: 10_000, maxFiles: 2, fullEvidence: true }).write(minimal, { session: "s", cwd: "/w" }, { request: "x" });
		new DebugLog({ path, maxBytes: 10_000, maxFiles: 2, fullEvidence: false }).write(minimal, { session: "s", cwd: "/w" }, { request: "y" });
		const [first, second] = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(first.fullEvidence, { request: "x" });
		assert.equal(second.fullEvidence, undefined);
		const blocked = join(dir, "file");
		writeFileSync(blocked, "not a directory");
		assert.doesNotThrow(() =>
			new DebugLog({ path: join(blocked, "decisions.jsonl"), maxBytes: 1, maxFiles: 1, fullEvidence: false }).write(minimal, { session: "s", cwd: "/w" }),
		);
	});
});
