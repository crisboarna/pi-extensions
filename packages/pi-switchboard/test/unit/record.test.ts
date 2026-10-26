import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BudgetTracker } from "../../src/budgets/track.ts";
import { DebugLog } from "../../src/record/debug-log.ts";
import { explain, summarize } from "../../src/record/describe.ts";
import { footerText, renderTemplate } from "../../src/record/footer.ts";
import type { DecisionEntry } from "../../src/record/types.ts";

const decision: DecisionEntry = {
	v: 1,
	id: "d_1",
	ts: "2026-10-25T12:00:00.000Z",
	task: 4,
	scope: "main",
	reason: "user",
	kind: "classified",
	profile: { name: "work", source: "default" },
	evidence: { digest: "abc", excerpt: "fix the build", tokens: 40, truncated: false },
	classifier: { model: "local/judge", latencyMs: 300, attempts: [{ model: "local/judge", ok: true, latencyMs: 300 }] },
	answers: { work: { type: "choice", choice: "implement", probabilities: {}, confidence: 0.91 }, depth: { type: "score", score: 1.1, confidence: 0.5 } },
	rules: { ruleset: "builtin", matched: 4, gate: { referenced: ["work"], confidence: 0.91, threshold: 0.8, passed: true }, floors: [] },
	tier: { candidate: "standard", chosen: "standard", rank: 2, why: "rule 5" },
	selection: {
		strategy: "round-robin",
		granularity: "session",
		why: "next",
		kept: false,
		shared: true,
		candidates: [
			{ member: "acme/mid", eligible: true },
			{ member: "zen/mid", eligible: false, excluded: "cooling down (rate limit)" },
		],
	},
	model: { provider: "acme", id: "mid", thinking: "medium" },
	switch: { from: "acme/small", cacheMiss: true },
};

describe("footer", () => {
	it("fills placeholders and drops empty fields with their separator", () => {
		assert.equal(renderTemplate("{profile} · {tier} · {member} · {confidence}", { profile: "work", tier: "deep", member: "big" }), "work · deep · big");
		assert.equal(
			footerText("{profile} · {tier} · {member} · {confidence}", decision, { pinned: "@top", dryRun: true }),
			"work · standard · mid · 0.91 · pinned @top · dry-run",
		);
		assert.equal(footerText("{tier}", undefined, { off: true }), "switchboard off");
		assert.equal(footerText("{tier}", undefined, { inactive: "no config" }), "switchboard inactive: no config");
	});
});

describe("descriptions", () => {
	it("summarizes a decision in one line", () => {
		assert.equal(summarize(decision), "⇄ task 4 · work=implement (0.91) · standard → mid:medium (round-robin) · cache miss");
	});

	it("explains answers, gate, candidates and the switch", () => {
		const text = explain(decision).join("\n");
		assert.match(text, /gate 0\.91 vs 0\.8 on \[work\] passed/u);
		assert.match(text, /✗ zen\/mid: cooling down \(rate limit\)/u);
		assert.match(text, /switch from acme\/small, cache miss/u);
	});
});

describe("debug log", () => {
	it("appends lines and rotates by size", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-debug-"));
		const path = join(dir, "decisions.jsonl");
		const log = new DebugLog({ path, maxBytes: 1500, maxFiles: 2, fullEvidence: false });
		for (let i = 0; i < 6; i++) log.write({ ...decision, id: `d_${i}` }, { session: "s", cwd: "/w" }, { request: "secret" });
		const files = readdirSync(dir).sort();
		assert.ok(files.includes("decisions.jsonl.1"));
		assert.ok(!files.includes("decisions.jsonl.3"));
		assert.ok(!readFileSync(path, "utf8").includes("fullEvidence"), "evidence stays out without fullEvidence");
	});
});

describe("budgets", () => {
	it("reports crossed budgets once and resets the task budget per task", () => {
		const tracker = new BudgetTracker();
		const budgets = { task: { tokens: 100 }, session: { costUsd: 1 } };
		tracker.startTask(1);
		tracker.add(150, 0.5);
		assert.deepEqual(
			tracker.newlyCrossed(budgets).map((b) => `${b.scope}:${b.metric}`),
			["task:tokens"],
		);
		assert.deepEqual(tracker.newlyCrossed(budgets), []);
		tracker.startTask(2);
		tracker.add(10, 0.6);
		assert.deepEqual(
			tracker.exceeded(budgets).map((b) => `${b.scope}:${b.metric}`),
			["session:costUsd"],
		);
		assert.deepEqual(
			tracker.newlyCrossed(budgets).map((b) => b.scope),
			["session"],
		);
	});
});
