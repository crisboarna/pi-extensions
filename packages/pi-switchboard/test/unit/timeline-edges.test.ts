import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderInspector } from "../../src/cli/inspector.ts";
import type { LiveStatus } from "../../src/live/live.ts";
import { DECISION_TYPE, type DecisionEntry, LINK_TYPE, PROFILE_TYPE } from "../../src/record/types.ts";
import { timelineFromMirror } from "../../src/timeline/mirror.ts";
import { buildTimeline, readEntries } from "../../src/timeline/parse.ts";

const decision = (id: string, extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
	v: 1,
	id,
	ts: "2026-10-26T09:00:00.000Z",
	task: 1,
	scope: "main",
	reason: "user",
	kind: "classified",
	profile: { name: "work", source: "default" },
	tier: { candidate: "mid", chosen: "mid", rank: 1, why: "rule 1" },
	model: { provider: "acme", id: "mid", thinking: "medium" },
	switch: { cacheMiss: false },
	...extra,
});
const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });
const message = (body: Record<string, unknown>, timestamp = "2026-10-26T09:00:01.000Z") => ({ type: "message", timestamp, message: body });

describe("readEntries", () => {
	it("skips blank and torn lines", () => {
		const file = join(mkdtempSync(join(tmpdir(), "switchboard-timeline-")), "s.jsonl");
		writeFileSync(file, '{"type":"session","id":"s1"}\n\n{"type":"mess');
		assert.deepEqual(readEntries(file), [{ type: "session", id: "s1" }]);
	});
});

describe("buildTimeline edge cases", () => {
	it("starts a task for work that arrives before any user message, and keeps a parent session", () => {
		const timeline = buildTimeline([
			{ type: "session", id: "child", parentSession: "/p/parent.jsonl" },
			custom(DECISION_TYPE, decision("d_retry", { reason: "retry", kind: "fallback" })),
			message({ role: "toolResult", content: [{ type: "image" }, null, { type: "text", text: "ok" }] }),
			message({ role: "assistant", content: "x", errorMessage: "overloaded".repeat(40) }, "not a date"),
			message({ role: "user", content: { not: "an array" } }),
			{ type: "message" },
			{ type: "branch" },
		]);
		assert.equal(timeline.parentSession, "/p/parent.jsonl");
		assert.equal(timeline.totals.fallbacks, 1);
		const [first, second] = timeline.tasks;
		assert.deepEqual(
			first?.decisions.map((d) => d.id),
			["d_retry"],
		);
		assert.equal(first?.tools[0]?.name, "tool");
		assert.equal(first?.tools[0]?.preview, "\n\nok");
		assert.deepEqual([first?.requests[0]?.provider, first?.requests[0]?.model, first?.requests[0]?.error?.length], ["", "", 300]);
		assert.equal(second?.request, "");
	});

	it("files trailing user decisions under the last task and links children with and without a session file", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-child-"));
		const childFile = join(dir, "child.jsonl");
		writeFileSync(childFile, `${JSON.stringify(message({ role: "user", content: "scan the repo" }))}\n`);
		const timeline = buildTimeline(
			[
				message({ role: "user", content: "go" }),
				custom(DECISION_TYPE, decision("d_launch_a", { reason: "launch", scope: "subagent" })),
				custom(DECISION_TYPE, decision("d_launch_b", { reason: "launch", scope: "subagent" })),
				custom(DECISION_TYPE, decision("d_launch_c", { reason: "launch", scope: "subagent" })),
				custom(LINK_TYPE, {
					v: 1,
					toolCallId: "t",
					links: [
						{ decisionId: "d_launch_a", taskIndex: 0, sessionFile: childFile },
						{ decisionId: "d_launch_b", taskIndex: 1 },
					],
				}),
				custom(LINK_TYPE, { v: 1, toolCallId: "u" }),
				custom(DECISION_TYPE, decision("d_late")),
			],
			{ childMirror: (link) => (link.decisionId === "d_launch_b" ? buildTimeline([message({ role: "user", content: "mirrored" })]) : undefined) },
		);
		const task = timeline.tasks[0];
		assert.deepEqual(
			task?.decisions.map((d) => d.id),
			["d_late"],
		);
		assert.equal(task?.children[0]?.timeline?.tasks[0]?.request, "scan the repo");
		assert.equal(task?.children[1]?.timeline?.tasks[0]?.request, "mirrored");
		assert.equal(task?.children[2]?.timeline, undefined);
	});
});

describe("timelineFromMirror", () => {
	it("builds a one-task timeline for a child without a session file", () => {
		const status: LiveStatus = {
			v: 1,
			session: "c1",
			status: "error",
			turn: 2,
			tokens: { input: 10, output: 5, cacheRead: 1 },
			cost: 0.5,
			startedAt: 1000,
			updatedAt: 2000,
		};
		const timeline = timelineFromMirror(status, [{ ts: 1500, kind: "tool-result", text: "boom", isError: true }]);
		const task = timeline.tasks[0];
		assert.deepEqual(
			[task?.request, task?.requests[0]?.provider, task?.requests[0]?.stopReason, task?.requests[0]?.durationMs, task?.tools[0]?.name],
			["", "", "error", undefined, "tool"],
		);
		const done = timelineFromMirror({ ...status, status: "done", model: "acme/big/v2", endedAt: 4000 }, [{ ts: 1100, kind: "task", text: "do it" }]);
		assert.deepEqual([done.tasks[0]?.request, done.tasks[0]?.requests[0]?.model, done.tasks[0]?.requests[0]?.durationMs], ["do it", "big/v2", 3000]);
	});
});

describe("renderInspector edge cases", () => {
	it("renders an empty session without prices", () => {
		const html = renderInspector(buildTimeline([]));
		assert.match(html, /No tasks\./);
		assert.match(html, /If all on top tier<\/span><b>n\/a/);
		assert.match(html, /Fallback rate<\/span><b>0%/);
	});

	it("marks fallbacks and errors, nests children, and prices against a snapshot", () => {
		const childTimeline = buildTimeline([
			message({ role: "user", content: "child work" }),
			message({ role: "assistant", provider: "acme", model: "mid", usage: { input: 2_000_000, output: 10 } }),
		]);
		const timeline = buildTimeline([
			{ type: "session", id: "s", cwd: "/work" },
			custom(PROFILE_TYPE, {
				v: 1,
				profile: "work",
				baselineTier: "mid",
				topTier: "top",
				tiers: [
					{ name: "mid", rank: 1, members: [{ key: "acme/mid", price: { input: 1, output: 2 } }] },
					{ name: "top", rank: 2, members: [{ key: "acme/top" }] },
				],
			}),
			message({ role: "user", content: "" }),
			custom(
				DECISION_TYPE,
				decision("d_fb", {
					kind: "fallback",
					rules: { ruleset: "builtin", matched: 1, gate: { referenced: ["work"], confidence: 0.3, threshold: 0.8, passed: false }, floors: [] },
				}),
			),
			message({
				role: "assistant",
				provider: "acme",
				model: "mid",
				thinkingLevel: "high",
				stopReason: "error",
				errorMessage: "429",
				usage: { input: 1500, output: 20, cost: { total: 0.25 } },
			}),
			message({ role: "assistant", provider: "zen", model: "other", usage: { input: 10, output: 2 } }, "2026-10-26T09:00:03.000Z"),
			custom(DECISION_TYPE, decision("d_launch", { reason: "launch", scope: "subagent" })),
			custom(LINK_TYPE, { v: 1, toolCallId: "t", links: [{ decisionId: "d_launch", taskIndex: 0, runId: "run-7" }] }),
		]);
		const child = timeline.tasks[0]?.children[0];
		if (child) child.timeline = childTimeline;
		const html = renderInspector(timeline, "Session <x>");
		assert.match(html, /Session &lt;x&gt;/);
		assert.match(html, /\(no request text\)/);
		assert.match(html, /class="decision warn"/);
		assert.match(html, /class="err"/);
		assert.match(html, /class="switch"/);
		assert.match(html, /run run-7/);
		assert.match(html, /child work/);
		assert.match(html, /1\.5k/);
		assert.match(html, /2\.0M/);
		assert.match(html, /· \/work/);
		assert.match(html, /Fallback rate<\/span><b>50%/);
	});
});
