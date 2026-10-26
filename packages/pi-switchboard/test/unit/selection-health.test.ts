import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { accountLabel, accountSiblings, mapToAccount, readMultiPassSubscriptions } from "../../src/selection/accounts.ts";
import { FileHealthStore } from "../../src/selection/health.ts";

const run = promisify(execFile);
const WORKER = join(import.meta.dirname, "..", "support", "round-robin-worker.ts");

describe("shared health file", () => {
	it("persists updates and survives a damaged file", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-health-"));
		const path = join(dir, "health.json");
		const store = new FileHealthStore(path);
		store.update((data) => {
			data.pointers["p/t"] = 3;
		});
		assert.equal(new FileHealthStore(path).read().pointers["p/t"], 3);
		writeFileSync(path, "{broken");
		assert.deepEqual(new FileHealthStore(path).read().pointers, {});
	});

	it("falls back to memory when the lock is held", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-health-"));
		const path = join(dir, "health.json");
		writeFileSync(`${path}.lock`, JSON.stringify({ pid: 1, ts: Date.now() }));
		const store = new FileHealthStore(path);
		store.update((data) => {
			data.pointers.x = 1;
		});
		assert.equal(store.shared, false);
	});

	it("lets two processes share one round-robin pointer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-health-"));
		const path = join(dir, "health.json");
		const [a, b] = await Promise.all([run(process.execPath, [WORKER, path, "40"]), run(process.execPath, [WORKER, path, "40"])]);
		const picks = [...a.stdout.trim().split("\n"), ...b.stdout.trim().split("\n")];
		const counts: Record<string, number> = {};
		for (const key of picks) counts[key] = (counts[key] ?? 0) + 1;
		assert.equal(picks.length, 80);
		assert.deepEqual(counts, { "a/x": 40, "b/y": 40 }, "every pick advanced the shared pointer exactly once");
		assert.ok(JSON.parse(readFileSync(path, "utf8")).pointers["p/t"] !== undefined);
	});
});

describe("accounts", () => {
	const isProvider = (name: string) => ["acme", "acme-2", "acme-3", "zen"].includes(name);

	it("reads multi-pass.json and MULTI_SUB", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-mp-"));
		writeFileSync(join(dir, "multi-pass.json"), JSON.stringify({ subscriptions: [{ provider: "acme", index: 2, label: "work" }] }));
		const subs = readMultiPassSubscriptions(dir, { MULTI_SUB: "acme:3" });
		assert.deepEqual(subs, [
			{ provider: "acme", index: 2, label: "work" },
			{ provider: "acme", index: 3 },
		]);
	});

	it("lists siblings, maps to a session's account and labels accounts", () => {
		const subs = [
			{ provider: "acme", index: 2, label: "work" },
			{ provider: "acme", index: 3 },
		];
		assert.deepEqual(accountSiblings("acme-2", subs, isProvider), ["acme", "acme-3"]);
		assert.equal(mapToAccount("acme", { acme: "acme-2" }, isProvider), "acme-2");
		assert.equal(mapToAccount("zen", { acme: "acme-2" }, isProvider), "zen");
		assert.equal(accountLabel("acme-2", subs, isProvider), "work");
		assert.equal(accountLabel("acme", subs, isProvider), "#1");
		assert.equal(accountLabel("zen", subs, isProvider), undefined);
	});
});
