import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveStatus } from "../../src/live/live.ts";
import type { DecisionEntry } from "../../src/record/types.ts";
import { buildRows, type NavModel, renderDecision, renderList, renderTranscript, type Style } from "../../src/tui/navigator.ts";

const decision: DecisionEntry = {
	v: 1,
	id: "d_launch",
	ts: "2026-10-26T09:00:00.000Z",
	task: 3,
	scope: "subagent",
	reason: "launch",
	kind: "classified",
	profile: { name: "work", source: "default" },
	tier: { candidate: "deep", chosen: "deep", rank: 3, why: "rule 1" },
	model: { provider: "acme", id: "big", thinking: "high" },
	switch: { cacheMiss: false },
	subagent: { agent: "scout", taskIndex: 0, toolCallId: "t", mode: "child" },
};
const child = (extra: Partial<LiveStatus> = {}): LiveStatus => ({
	v: 1,
	session: "c1",
	status: "running",
	turn: 1,
	tokens: { input: 1500, output: 2_500_000, cacheRead: 0 },
	cost: 0.004,
	startedAt: Date.parse("2026-10-26T09:00:01.000Z"),
	updatedAt: Date.parse("2026-10-26T09:00:02.000Z"),
	...extra,
});
const tagged: Style = (role, text) => `<${role}>${text}`;

describe("buildRows", () => {
	it("labels the main row without a decision and children by agent, launch id or neither", () => {
		const rows = buildRows(
			{ running: false, tokensIn: 0, tokensOut: 0, cost: 0 },
			[
				child({ agent: "scout" }),
				child({ session: "c2", launchDecisionId: "d_launch", tier: "light", model: "acme/small", currentTool: "bash", tokensPerSecond: 40 }),
				child({ session: "c3" }),
			],
			[decision],
		);
		assert.deepEqual(
			rows.map((row) => [row.label, row.status, row.tier, row.model, row.decision?.id]),
			[
				["main", "idle", undefined, undefined, undefined],
				["scout", "running", "deep", undefined, "d_launch"],
				["subagent", "running", "light", "acme/small", "d_launch"],
				["subagent", "running", undefined, undefined, undefined],
			],
		);
		assert.deepEqual([rows[2]?.tool, rows[2]?.tokensPerSecond], ["bash", 40]);
	});
});

describe("renderList", () => {
	it("shows status icons, tree branches, compact numbers, cooldowns, budget warnings and auto-continue", () => {
		const rows = buildRows(
			{ decision: { ...decision, scope: "main", task: 3 }, running: true, tokensIn: 0, tokensOut: 0, cost: 0 },
			[child({ status: "error" }), child({ session: "c2", status: "done", tier: "light", tokensPerSecond: 12 })],
			[],
		);
		rows.push({ key: "x", label: "idle", status: "idle", tokensIn: 0, tokensOut: 0, cost: 2, depth: 1 });
		const model: NavModel = {
			rows,
			profile: "work",
			cooldowns: [{ member: "acme/mid", until: Date.parse("2026-10-26T10:00:00.000Z"), reason: "rate limit" }],
			budgetWarnings: ["session cost over budget"],
			autoContinueAt: 1_000_000 + 180_000,
			now: 1_000_000,
		};
		const lines = renderList(model, 1, tagged);
		const text = lines.join("\n");
		assert.match(lines[0] ?? "", /^<accent>⇄ switchboard · work · 1 running · deep 1 · \$2\.01 · <warning>over budget/);
		assert.match(text, /<bold>› ├ <error>✗ subagent/);
		assert.match(text, /├ <success>✓ subagent/);
		assert.match(text, /└ ○ idle/);
		assert.match(text, /1\.5k\/2\.5M/);
		assert.match(text, /12 t\/s/);
		assert.match(text, /\$0\.004/);
		assert.match(text, /<warning>cooldown: acme\/mid until/);
		assert.match(text, /<warning>session cost over budget/);
		assert.match(text, /<dim>auto-continue in 3 min/);
		const quiet = renderList({ rows: rows.slice(0, 1), cooldowns: [], budgetWarnings: [], now: 0 }, 5);
		assert.match(quiet[0] ?? "", /budget ok/);
	});
});

describe("renderDecision and renderTranscript", () => {
	it("explains the row's decision, or says there is none", () => {
		const row = { key: "c", label: "scout", status: "done" as const, tokensIn: 0, tokensOut: 0, cost: 0, depth: 1 };
		assert.ok(renderDecision({ ...row, decision }).some((line) => line.startsWith("d_launch")));
		assert.ok(renderDecision(row).includes("No routing decision recorded for this row."));
	});

	it("tags every kind of transcript line and scrolls", () => {
		const row = { key: "c", label: "scout", status: "done" as const, tokensIn: 0, tokensOut: 0, cost: 0, depth: 1 };
		const lines = renderTranscript(
			row,
			[
				{ ts: 1, kind: "task", text: "scan" },
				{ ts: 2, kind: "tool-call", tool: "bash", text: "ls" },
				{ ts: 3, kind: "tool-result", tool: "bash", text: "ok" },
				{ ts: 4, kind: "tool-result", tool: "bash", text: "denied", isError: true },
				{ ts: 5, kind: "error", text: "boom" },
				{ ts: 6, kind: "text", text: "done   now" },
			],
			0,
			20,
			tagged,
		);
		const text = lines.join("\n");
		for (const expected of ["<dim>task", "<dim>→ bash", "<dim>← bash", "<warning>✗ bash", "<warning>error", "<dim>reply"])
			assert.ok(text.includes(expected), expected);
		assert.match(text, /done now/);
		const scrolled = renderTranscript(
			row,
			Array.from({ length: 10 }, (_, i) => ({ ts: i, kind: "text" as const, text: `line ${i}` })),
			3,
			5,
		);
		assert.deepEqual(
			scrolled.slice(1, -1).map((line) => line.trim().split(" ").at(-1)),
			["5", "6"],
		);
	});
});
