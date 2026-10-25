import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderInspector } from "../../src/cli/inspector.ts";
import { formatReplay } from "../../src/cli/main.ts";
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
		assert.deepEqual(first?.tools.map((t) => [t.name, t.isError]), [["bash", true]]);
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
		const t = buildTimeline([{ type: "message", message: { role: "user", content: "hi" } }, { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, cost: { total: 0 } } } }]);
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
