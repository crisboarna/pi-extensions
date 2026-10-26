import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/classifier/redact.ts";
import { LiveWriter, readChildren, readMirror, sweep } from "../../src/live/live.ts";

const dir = () => mkdtempSync(join(tmpdir(), "switchboard-live-"));

describe("live status and mirror", () => {
	it("writes status, bounded and redacted mirror lines, and reads children by parent", () => {
		const d = dir();
		const writer = new LiveWriter({
			dir: d,
			session: "child-1",
			parent: "/s/parent.jsonl",
			redact: createRedactor({ home: "/home/dev" }),
			limits: { toolResultBytes: 20 },
			now: 1000,
		});
		writer.update({ agent: "scout", turn: 1, currentTool: "bash" }, 1000);
		writer.append({ kind: "task", text: "scan /home/dev/repo" }, 1001);
		writer.append({ kind: "tool-result", tool: "bash", text: `token=supersecretvalue ${"x".repeat(100)}` }, 1002);
		writer.streamStarted(1000);
		writer.assistant({ provider: "acme", model: "mid", text: "found it", usage: { input: 100, output: 50, cost: { total: 0.01 } } }, 3000);
		writer.finish("done", 3001);
		const [status] = readChildren(d, "/s/parent.jsonl");
		assert.equal(status?.status, "done");
		assert.equal(status?.model, "acme/mid");
		assert.equal(status?.tokens.output, 50);
		assert.equal(status?.tokensPerSecond, 25);
		assert.equal(status?.currentTool, undefined);
		const mirror = readMirror(d, "child-1");
		assert.deepEqual(
			mirror.map((m) => m.kind),
			["task", "tool-result", "text"],
		);
		assert.equal(mirror[0]?.text, "scan ~/repo");
		assert.ok(!mirror[1]?.text.includes("supersecretvalue"));
		assert.ok(Buffer.byteLength(mirror[1]?.text ?? "") <= 24, "tool results are capped");
		assert.deepEqual(readChildren(d, "/other"), []);
	});

	it("sweeps children that ended more than the retention ago", () => {
		const d = dir();
		const now = Date.UTC(2026, 9, 26);
		const old = new LiveWriter({ dir: d, session: "old", parent: "p", redact: (t) => t, now: now - 30 * 3_600_000 });
		old.append({ kind: "task", text: "x" });
		old.finish("done", now - 25 * 3_600_000);
		const fresh = new LiveWriter({ dir: d, session: "fresh", parent: "p", redact: (t) => t, now });
		fresh.finish("done", now - 3_600_000);
		const running = new LiveWriter({ dir: d, session: "running", parent: "p", redact: (t) => t, now });
		running.update({ turn: 1 }, now);
		running.flush(now);
		writeFileSync(join(d, "broken.json"), "{");
		utimesSync(join(d, "broken.json"), new Date(now - 48 * 3_600_000), new Date(now - 48 * 3_600_000));
		assert.equal(sweep(d, 24, now), 2);
		assert.ok(!existsSync(join(d, "old.json")) && !existsSync(join(d, "old.jsonl")));
		assert.ok(existsSync(join(d, "fresh.json")) && existsSync(join(d, "running.json")));
	});
});
