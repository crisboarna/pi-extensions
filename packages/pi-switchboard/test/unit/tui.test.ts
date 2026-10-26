import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RawConfig } from "../../src/config/types.ts";
import type { LiveStatus } from "../../src/live/live.ts";
import type { DecisionEntry } from "../../src/record/types.ts";
import { type EditorUi, lineDiff, runTierEditor, stableStringify } from "../../src/tui/editor.ts";
import { buildRows, renderDecision, renderList, renderTranscript, widgetLine } from "../../src/tui/navigator.ts";

const launch = (agent: string, tier: string, ts: string): DecisionEntry => ({
	v: 1,
	id: `d_${agent}`,
	ts,
	task: 0,
	scope: "subagent",
	reason: "launch",
	kind: "classified",
	profile: { name: "work", source: "default" },
	tier: { candidate: tier, chosen: tier, rank: 1, why: "rules" },
	model: { provider: "switchboard", id: `work.${tier}`, thinking: "medium" },
	switch: { cacheMiss: false },
	subagent: { agent, taskIndex: 0, toolCallId: "c", mode: "child", launchTier: tier },
});

const child = (session: string, agent: string, status: LiveStatus["status"], startedAt: number): LiveStatus =>
	({
		v: 1,
		session,
		parent: "p",
		agent,
		status,
		model: "acme/small",
		turn: 3,
		currentTool: status === "running" ? "grep" : undefined,
		tokens: { input: 9000, output: 2000, cacheRead: 1000 },
		cost: 0.01,
		tokensPerSecond: 70,
		startedAt,
		updatedAt: startedAt,
	}) as LiveStatus;

describe("navigator", () => {
	const start = Date.UTC(2026, 9, 26, 10);
	const rows = buildRows(
		{ running: true, tokensIn: 41_000, tokensOut: 12_000, cost: 0.18 },
		[child("c1", "scout", "running", start), child("c2", "reviewer", "done", start)],
		[launch("scout", "light", new Date(start - 1000).toISOString())],
	);

	it("joins a child to its launch decision by the binding's id first", () => {
		const exact = buildRows(
			{ running: false, tokensIn: 0, tokensOut: 0, cost: 0 },
			[{ ...child("c9", "scout", "running", start), launchDecisionId: "d_other" } as LiveStatus],
			[
				launch("scout", "light", new Date(start - 1000).toISOString()),
				{ ...launch("scout", "deep", new Date(start - 500).toISOString()), id: "d_other" },
			],
		);
		assert.equal(exact[1]?.decision?.id, "d_other");
		assert.equal(exact[1]?.tier, "deep");
	});

	it("builds a main row and one row per child, joined to launch decisions", () => {
		assert.deepEqual(
			rows.map((r) => [r.label, r.status, r.tier]),
			[
				["main", "running", undefined],
				["scout", "running", "light"],
				["reviewer", "done", undefined],
			],
		);
	});

	it("renders the list with totals, per-tier counts and keys", () => {
		const lines = renderList(
			{ rows, profile: "work", cooldowns: [{ member: "acme/big", until: start + 600_000, reason: "rate limit" }], budgetWarnings: [], now: start },
			1,
		);
		assert.match(lines[0] ?? "", /⇄ switchboard · work · 2 running · light 1 · \$0\.20 · budget ok/u);
		assert.ok(lines.some((l) => l.startsWith("› ") && l.includes("scout") && l.includes("70 t/s")));
		assert.ok(lines.some((l) => l.includes("cooldown: acme/big")));
		assert.match(lines.at(-1) ?? "", /enter decision · t transcript/u);
	});

	it("renders the decision and a scrolled transcript", () => {
		const decision = renderDecision(rows[1]!);
		assert.ok(decision.some((l) => l.includes("subagent: scout")));
		const mirror = Array.from({ length: 30 }, (_, i) => ({ ts: i, kind: "text" as const, text: `line ${i}` }));
		const view = renderTranscript(rows[1]!, mirror, 0, 13);
		assert.equal(view.length, 12);
		assert.match(view.at(-2) ?? "", /line 29/u, "follows the tail");
		assert.match(renderTranscript(rows[1]!, mirror, 5, 13).at(-2) ?? "", /line 24/u);
	});

	it("shows the widget only while children run or a continue is pending", () => {
		assert.equal(widgetLine({ rows, cooldowns: [], budgetWarnings: [], now: start }), "⇄ 1 running · light 1 · $0.20");
		assert.equal(widgetLine({ rows: rows.slice(0, 1), cooldowns: [], budgetWarnings: [], now: start }), undefined);
		assert.match(
			widgetLine({ rows: rows.slice(0, 1), cooldowns: [], budgetWarnings: [], autoContinueAt: start + 120_000, now: start }) ?? "",
			/continue in 2 min/u,
		);
	});
});

/** Answers the editor's dialogs from a script, in order. */
function scripted(answers: Array<string | boolean | undefined>): EditorUi & { notes: string[] } {
	const queue = [...answers];
	const notes: string[] = [];
	const next = () => queue.shift();
	return {
		notes,
		select: async (_title, options) => {
			const answer = next();
			if (typeof answer === "string" && !options.includes(answer)) throw new Error(`"${answer}" is not one of: ${options.join(" | ")}`);
			return answer as string | undefined;
		},
		input: async () => next() as string | undefined,
		confirm: async () => next() === true,
		notify: (message) => notes.push(message),
	};
}

describe("tier editor", () => {
	const raw: RawConfig = { version: 1, profiles: { work: { tiers: { standard: { rank: 1, members: ["acme/mid"] } } } } };
	const models = ["acme/big", "acme/mid", "zen/small"];

	it("adds a tier and a member, then saves with a backup after confirmation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-editor-"));
		const path = join(dir, "pi-switchboard.json");
		writeFileSync(path, stableStringify(raw));
		const ui = scripted([
			"profile: work",
			"+ add tier",
			"deep",
			"acme/big",
			"tier: standard",
			"members",
			"+ add member",
			"zen/small",
			"low",
			"← back",
			"strategy",
			"round-robin",
			"← back",
			"make default",
			"← back",
			"✓ save and close",
			true,
		]);
		assert.equal(await runTierEditor(ui, { path, raw, models }), true);
		const saved = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
		assert.deepEqual(saved.profiles?.work?.tiers.deep, { rank: 2, members: ["acme/big"] });
		assert.deepEqual(saved.profiles?.work?.tiers.standard?.members, ["acme/mid", "zen/small:low"]);
		assert.equal(saved.profiles?.work?.tiers.standard?.strategy, "round-robin");
		assert.equal(saved.profileSelection?.default, "work");
		assert.ok(
			readdirSync(dir).some((f) => f.endsWith(".bak")),
			"a backup was written",
		);
	});

	it("refuses to save an invalid result and never writes without confirmation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-editor-"));
		const path = join(dir, "pi-switchboard.json");
		const broken = scripted([
			"profile: work",
			"tier: standard",
			"members",
			"1. acme/mid",
			"remove",
			"← back",
			"← back",
			"← back",
			"✓ save and close",
			"✗ close without saving",
		]);
		assert.equal(await runTierEditor(broken, { path, raw, models }), false);
		assert.ok(broken.notes.some((n) => n.includes("Not saved")));
		assert.equal(existsSync(path), false);
		const declined = scripted(["profile: work", "make default", "← back", "✓ save and close", false]);
		assert.equal(await runTierEditor(declined, { path, raw, models }), false);
		assert.equal(existsSync(path), false);
	});

	it("diffs with context", () => {
		assert.equal(lineDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne", 1), "  …\n  b\n- c\n+ X\n  d\n  …");
	});
});
