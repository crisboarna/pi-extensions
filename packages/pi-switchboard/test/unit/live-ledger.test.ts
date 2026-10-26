import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Member } from "../../src/config/types.ts";
import { findChildByDecision, LiveWriter, readChildren, readMirror, sweep } from "../../src/live/live.ts";
import { ledgerQuota, parseWindow, UsageLedger } from "../../src/selection/ledger.ts";

const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `switchboard-${name}-`));
const redact = (text: string) => text.replace(/secret/gu, "[redacted]");

describe("LiveWriter", () => {
	it("records the parent, sums usage without fields, and mirrors errors", () => {
		const dir = tempDir("live");
		const writer = new LiveWriter({ dir, session: "child/1", parent: "/p.jsonl", redact, now: 1000 });
		writer.assistant({ text: "" }, 1100);
		writer.assistant(
			{ text: "a secret", provider: "acme", model: "mid", usage: { input: 5, output: 10, cacheRead: 2, cost: { total: 0.1 } }, error: "boom" },
			1200,
		);
		writer.finish("error", 1300);
		const status = JSON.parse(readFileSync(join(dir, "child_1.json"), "utf8"));
		assert.deepEqual(
			[status.parent, status.tokens, status.cost, status.model, status.status, status.lastText],
			["/p.jsonl", { input: 5, output: 10, cacheRead: 2 }, 0.1, "acme/mid", "error", "a [redacted]"],
		);
		assert.deepEqual(
			readMirror(dir, "child/1").map((line) => line.kind),
			["text", "error"],
		);
	});

	it("writes no mirror when the mirror is off, and never throws when the directory goes away", () => {
		const dir = tempDir("live-off");
		const quiet = new LiveWriter({ dir, session: "s", redact, mirror: false, now: 0 });
		quiet.append({ kind: "task", text: "x" });
		assert.deepEqual(readMirror(dir, "s"), []);
		const blocked = join(tempDir("live-blocked"), "file");
		writeFileSync(blocked, "not a directory");
		const writer = new LiveWriter({ dir: tempDir("live-gone"), session: "s", redact, now: 0 });
		(writer as unknown as { dir: string }).dir = blocked;
		assert.doesNotThrow(() => writer.append({ kind: "task", text: "x" }));
		assert.doesNotThrow(() => writer.flush(5));
	});
});

describe("reading live files", () => {
	it("finds children of any of several parents, skipping other files and torn ones", () => {
		const dir = tempDir("children");
		const status = (session: string, parent: string, startedAt: number, extra = {}) =>
			writeFileSync(join(dir, `${session}.json`), JSON.stringify({ v: 1, session, parent, startedAt, status: "done", ...extra }));
		status("b", "/p2", 20);
		status("a", "/p1", 10, { launchDecisionId: "d_a" });
		status("c", "/other", 5);
		writeFileSync(join(dir, "torn.json"), "{");
		writeFileSync(join(dir, "notes.txt"), "x");
		writeFileSync(join(dir, "a.jsonl"), '{"ts":1,"kind":"task","text":"go"}\n{torn\n');
		assert.deepEqual(
			readChildren(dir, ["/p1", "/p2"]).map((child) => child.session),
			["a", "b"],
		);
		assert.equal(findChildByDecision(dir, "d_a")?.session, "a");
		assert.equal(findChildByDecision(dir, "d_none"), undefined);
		assert.deepEqual(readMirror(dir, "a"), [{ ts: 1, kind: "task", text: "go" }]);
		assert.deepEqual(readChildren(join(dir, "missing"), "/p1"), []);
		assert.equal(findChildByDecision(join(dir, "missing"), "d_a"), undefined);
		assert.equal(sweep(join(dir, "missing"), 1), 0);
	});

	it("sweeps ended and long-silent children and torn files past the retention", () => {
		const dir = tempDir("sweep");
		const hour = 3_600_000;
		const now = 100 * hour;
		writeFileSync(join(dir, "ended.json"), JSON.stringify({ endedAt: now - 2 * hour }));
		writeFileSync(join(dir, "ended.jsonl"), "x");
		writeFileSync(join(dir, "silent.json"), JSON.stringify({ updatedAt: now - 5 * hour }));
		writeFileSync(join(dir, "running.json"), JSON.stringify({ updatedAt: now - hour / 2 }));
		writeFileSync(join(dir, "torn.json"), "{");
		utimesSync(join(dir, "torn.json"), (now - 3 * hour) / 1000, (now - 3 * hour) / 1000);
		mkdirSync(join(dir, "sub"));
		assert.equal(sweep(dir, 1, now), 3);
		assert.deepEqual(readChildren(dir, "/x"), []);
	});
});

describe("UsageLedger", () => {
	it("reads both files, skips torn lines and older entries, and never throws on write", () => {
		const dir = tempDir("ledger");
		const path = join(dir, "usage.jsonl");
		const entry = (ts: string) =>
			JSON.stringify({ ts, session: "s", task: 1, provider: "acme", model: "mid", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 });
		writeFileSync(`${path}.1`, `${entry("2026-10-25T00:00:00.000Z")}\n`);
		writeFileSync(path, `${entry("2026-10-26T00:00:00.000Z")}\n{torn\n\n`);
		const ledger = new UsageLedger(path);
		assert.equal(ledger.read().length, 2);
		assert.equal(ledger.read(Date.parse("2026-10-25T12:00:00.000Z")).length, 1);
		const blocked = join(dir, "file");
		writeFileSync(blocked, "x");
		assert.doesNotThrow(() => new UsageLedger(join(blocked, "usage.jsonl")).append(JSON.parse(entry("2026-10-26T00:00:00.000Z"))));
	});

	it("parses windows and computes quota from token and cost budgets", () => {
		assert.equal(parseWindow("5h"), 5 * 3_600_000);
		assert.equal(parseWindow("2w"), undefined);
		const member = (budget?: Member["budget"]): Member => ({
			key: "acme/mid",
			provider: "acme",
			id: "mid",
			weight: 1,
			enabled: true,
			tags: [],
			index: 0,
			...(budget ? { budget } : {}),
		});
		const now = Date.UTC(2026, 9, 26, 12, 30);
		const entries = [
			{
				ts: "2026-10-26T12:10:00.000Z",
				session: "s",
				task: 1,
				provider: "acme",
				model: "mid",
				input: 400,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.5,
			},
			{
				ts: "2026-10-26T12:15:00.000Z",
				session: "s",
				task: 1,
				provider: "zen",
				model: "mid",
				input: 999,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 9,
			},
		];
		assert.equal(ledgerQuota(entries, member(), now), undefined);
		assert.equal(ledgerQuota(entries, member({ window: "1h" }), now), undefined);
		assert.equal(ledgerQuota(entries, member({ window: "bad", tokens: 1 }), now), undefined);
		assert.deepEqual(ledgerQuota(entries, member({ window: "1h", costUsd: 2 }), now), {
			remaining: 0.75,
			resetsAt: Date.UTC(2026, 9, 26, 13),
			source: "ledger",
		});
		assert.equal(ledgerQuota(entries, member({ window: "1h", tokens: 1000, costUsd: 0.5 }), now)?.remaining, 0);
	});
});
