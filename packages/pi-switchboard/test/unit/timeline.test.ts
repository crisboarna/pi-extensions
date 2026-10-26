import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/classifier/redact.ts";
import { renderInspector } from "../../src/cli/inspector.ts";
import { formatReplay } from "../../src/cli/main.ts";
import { LiveWriter } from "../../src/live/live.ts";
import { liveChildMirror } from "../../src/timeline/mirror.ts";
import { aggregate, buildTimeline, timelineFromFile } from "../../src/timeline/parse.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "session-routed.jsonl");
const BIN = join(import.meta.dirname, "..", "..", "bin", "pi-switchboard.mjs");

describe("timeline", () => {
	const timeline = timelineFromFile(FIXTURE);

	it("groups decisions, requests, tools and children by task", () => {
		assert.equal(timeline.tasks.length, 2);
		const [first, second] = timeline.tasks;
		assert.equal(first?.decisions[0]?.tier.chosen, "standard");
		assert.equal(first?.requests.length, 2);
		assert.deepEqual(
			first?.tools.map((t) => [t.name, t.isError]),
			[["bash", true]],
		);
		assert.equal(second?.decisions[0]?.tier.chosen, "deep");
		assert.equal(second?.requests[0]?.switched, true, "a new physical model is a cache miss");
		assert.equal(second?.children.length, 1);
		assert.equal(second?.children[0]?.runId, "run-1");
	});

	it("totals cost, switches and fallbacks", () => {
		assert.equal(timeline.totals.switches, 1);
		assert.equal(timeline.totals.requests, 3);
		assert.ok(Math.abs(timeline.totals.cost - 0.035) < 1e-9);
		assert.deepEqual([...aggregate(timeline, (_r, d) => d?.tier.chosen ?? "").keys()].sort(), ["deep", "standard"]);
	});

	it("tolerates torn lines and sessions without decisions", () => {
		const t = buildTimeline([
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, cost: { total: 0 } } } },
		]);
		assert.equal(t.tasks.length, 1);
		assert.equal(t.totals.decisions, 0);
	});
});

describe("replay and inspector", () => {
	it("prints a readable offline timeline", () => {
		const text = formatReplay(timelineFromFile(FIXTURE));
		assert.match(text, /task 1: fix the failing build/u);
		assert.match(text, /⇄ task 2 · work=plan \(0\.94\) · deep → big:high/u);
		assert.match(text, /\[switch\]/u);
		assert.match(text, /⤷ .*scout/u);
	});

	it("renders a self-contained HTML page with summaries and filters", () => {
		const html = renderInspector(timelineFromFile(FIXTURE));
		assert.match(html, /^<!doctype html>/u);
		assert.ok(!/<script src=|<link rel="stylesheet" href=/u.test(html), "no external resources");
		assert.match(html, /By tier/u);
		assert.match(html, /If all on top tier/u);
		assert.match(html, /data-tier="deep"/u);
		assert.ok(!html.includes("<script>alert"), "request text is escaped");
	});

	it("runs as a CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-cli-"));
		const out = join(dir, "inspect.html");
		const printed = execFileSync(process.execPath, [BIN, "inspect", FIXTURE, "-o", out], { encoding: "utf8" });
		assert.equal(printed.trim(), out);
		assert.match(readFileSync(out, "utf8"), /Switchboard inspector/u);
		const replay = execFileSync(process.execPath, [BIN, "replay", FIXTURE], { encoding: "utf8" });
		assert.match(replay, /2 tasks/u);
		writeFileSync(join(dir, "x.jsonl"), "");
	});
});

describe("child transcript mirrors", () => {
	/** A live directory holding the in-memory child that the fixture's launch decision d_3 started. */
	function liveDir() {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-mirror-"));
		const writer = new LiveWriter({ dir, session: "child-xyz", parent: "p", redact: createRedactor(), now: Date.UTC(2026, 9, 25, 12, 1, 12) });
		writer.update({ agent: "scout", launchDecisionId: "d_3", model: "acme/small" });
		writer.append({ kind: "task", text: "scan the repo" });
		writer.append({ kind: "tool-call", tool: "grep", text: '{"pattern":"retry"}' });
		writer.append({ kind: "tool-result", tool: "grep", text: "src/retry.ts:12 <script>alert(1)</script>" });
		writer.append({ kind: "tool-result", tool: "bash", isError: true, text: "exit 1" });
		writer.assistant({ provider: "acme", model: "small", text: "found it", usage: { input: 900, output: 100, cacheRead: 50, cost: { total: 0.004 } } });
		writer.finish("done", Date.UTC(2026, 9, 25, 12, 1, 20));
		return dir;
	}

	it("rebuilds an in-memory child from its mirror, joined by the launch decision id", () => {
		const timeline = timelineFromFile(FIXTURE, { childMirror: liveChildMirror(liveDir()) });
		const child = timeline.tasks[1]?.children[0];
		assert.ok(child?.timeline?.mirror, "the child has a mirror timeline");
		const task = child?.timeline?.tasks[0];
		assert.equal(task?.request, "scan the repo");
		assert.deepEqual(
			task?.tools.map((t) => [t.name, t.isError]),
			[
				["grep", false],
				["bash", true],
			],
		);
		assert.equal(task?.requests[0]?.model, "small");
		assert.equal(task?.requests[0]?.durationMs, 8000);
		assert.ok(Math.abs((task?.cost ?? 0) - 0.004) < 1e-9);
	});

	it("shows the mirror in the inspector, escaped, and says so when no mirror exists", () => {
		const withMirror = renderInspector(timelineFromFile(FIXTURE, { childMirror: liveChildMirror(liveDir()) }));
		assert.match(withMirror, /transcript mirror \(5 entries/u);
		assert.ok(!withMirror.includes("<script>alert(1)</script>"), "mirror text is escaped");
		assert.match(withMirror, /&lt;script&gt;/u);
		const without = renderInspector(timelineFromFile(FIXTURE, { childMirror: liveChildMirror(mkdtempSync(join(tmpdir(), "switchboard-empty-"))) }));
		assert.match(without, /already swept/u);
	});

	it("includes mirror children in replay and totals by model", () => {
		const timeline = timelineFromFile(FIXTURE, { childMirror: liveChildMirror(liveDir()) });
		assert.match(formatReplay(timeline), /scan the repo/u);
		assert.ok(aggregate(timeline, (r) => `${r.provider}/${r.model}`).has("acme/small"));
	});
});
