// pi-switchboard keeps three kinds of file under the agent directory: shared health, a usage ledger and transcript mirrors of subagents. Other pi
// processes write them, a crash can tear them, and a person can edit them. Routing must never fail because of one, and a line that parses must
// not be trusted just because it parses. Each case is a real file read by the real reader.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readMirror } from "../../src/live/live.ts";
import { FileHealthStore, type HealthData } from "../../src/selection/health.ts";
import { ledgerQuota, UsageLedger } from "../../src/selection/ledger.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "switchboard-hostile-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BOM = String.fromCharCode(0xfeff);
const isPlainMap = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);

describe("a health file that is damaged, or valid JSON of the wrong shape", () => {
	const HOSTILE: Record<string, string> = {
		"an empty file": "",
		"a truncated file": '{"v":1,"members":{"a/b":{"cooldownUnt',
		"a byte order mark": `${BOM}{"v":1}`,
		"NUL bytes": "\u0000\u0000{{",
		null: "null",
		"a number": "5",
		"a string": '"x"',
		"an array": "[]",
		"another version": '{"v":2,"members":{}}',
		"members that is a number": '{"v":1,"members":5}',
		"members that is a list": '{"v":1,"members":[]}',
		"members that is null": '{"v":1,"members":null}',
		"pointers that is a string": '{"v":1,"pointers":"x"}',
		"a member that is a number": '{"v":1,"members":{"acme/m1":5}}',
		"a swrr table that is a number": '{"v":1,"swrr":{"fast":5}}',
		"an accounts table that is a list": '{"v":1,"accounts":{"s1":[]}}',
		"a __proto__ key": '{"v":1,"members":{"__proto__":{"cooldownUntil":9e15}},"__proto__":{"v":1}}',
	};

	for (const [name, text] of Object.entries(HOSTILE)) {
		it(`${name}: reading gives usable data, and an update that follows does not throw and is kept`, () => {
			const path = join(dir, "health.json");
			writeFileSync(path, text);
			const store = new FileHealthStore(path);
			const data = store.read();
			for (const key of ["members", "pointers", "swrr", "accounts"] as const) assert.ok(isPlainMap(data[key]), `${key} is a map`);
			store.update((health: HealthData) => {
				health.members["acme/m1"] = { overloads: 1 };
				health.pointers["main/fast"] = 2;
				health.swrr["main/fast"] = { "acme/m1": 3 };
				health.accounts.s1 = { acme: "acme-2" };
			});
			const after = JSON.parse(readFileSync(path, "utf8")) as HealthData;
			assert.equal(after.members["acme/m1"]?.overloads, 1);
			assert.equal(after.pointers["main/fast"], 2);
			assert.equal(({} as Record<string, unknown>).cooldownUntil, undefined, "Object.prototype is untouched");
		});
	}

	it("10 MB of junk is read as nothing, and quickly", () => {
		const path = join(dir, "health.json");
		writeFileSync(path, "x".repeat(10 * 1024 * 1024));
		const started = Date.now();
		const data = new FileHealthStore(path).read();
		assert.deepEqual(Object.keys(data.members), []);
		assert.ok(Date.now() - started < 3000);
	});
});

describe("a usage ledger with lines that are torn, or that parse but are not entries", () => {
	const GOOD = {
		ts: "2026-11-02T10:00:00.000Z",
		session: "s",
		task: 1,
		provider: "acme",
		model: "m1",
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.5,
	};
	const member = { provider: "acme", id: "m1", budget: { window: "1d", tokens: 1000, costUsd: 10 } } as never;
	const NOW = Date.parse("2026-11-02T12:00:00.000Z");

	function read(lines: string[]) {
		const path = join(dir, "usage.jsonl");
		writeFileSync(path, `${lines.join("\n")}\n`);
		return new UsageLedger(path).read();
	}

	it("keeps the good lines and drops a torn one, wherever it is", () => {
		const entries = read([JSON.stringify(GOOD), '{"ts":"2026-11-02T10:00:0', JSON.stringify({ ...GOOD, task: 2 })]);
		assert.deepEqual(
			entries.map((entry) => entry.task),
			[1, 2],
		);
	});

	const NOT_ENTRIES: Record<string, string> = {
		null: "null",
		"a number": "5",
		"a string": '"x"',
		"a list": "[1,2]",
		"an empty object": "{}",
		"an entry with a string where a number goes": JSON.stringify({ ...GOOD, input: "5" }),
		"an entry with a negative cost": JSON.stringify({ ...GOOD, cost: -1e9 }),
		"an entry with a negative token count": JSON.stringify({ ...GOOD, output: -500 }),
		"an entry with a number too big for a double":
			'{"ts":"2026-11-02T10:00:00.000Z","session":"s","task":1,"provider":"acme","model":"m1","input":1e999,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0}',
		"an entry with no time": JSON.stringify({ ...GOOD, ts: undefined }),
		"an entry whose time is not a date": JSON.stringify({ ...GOOD, ts: "later" }),
		"an entry whose provider is a list": JSON.stringify({ ...GOOD, provider: ["acme"] }),
	};

	for (const [name, line] of Object.entries(NOT_ENTRIES)) {
		it(`drops ${name}, so the quota is never NaN or inflated by it`, () => {
			const entries = read([JSON.stringify(GOOD), line]);
			assert.equal(entries.length, 1, `only the good entry is kept; got ${JSON.stringify(entries)}`);
			const quota = ledgerQuota(entries, member, NOW);
			assert.ok(quota && Number.isFinite(quota.remaining) && quota.remaining > 0 && quota.remaining < 1, JSON.stringify(quota));
		});
	}

	it("reads nothing, without throwing, from a file that is a directory or does not exist", () => {
		mkdirSync(join(dir, "usage.jsonl"));
		assert.deepEqual(new UsageLedger(join(dir, "usage.jsonl")).read(), []);
		assert.deepEqual(new UsageLedger(join(dir, "nowhere.jsonl")).read(), []);
	});
});

describe("a subagent transcript mirror with lines that parse but are not transcript lines", () => {
	const GOOD = { ts: 1700000000000, kind: "text", text: "hello" };

	function mirror(lines: string[]) {
		writeFileSync(join(dir, "session-1.jsonl"), `${lines.join("\n")}\n`);
		return readMirror(dir, "session-1");
	}

	it("keeps the good lines and drops a torn one", () => {
		assert.deepEqual(
			mirror([JSON.stringify(GOOD), '{"ts":1700000000', JSON.stringify({ ...GOOD, text: "again" })]).map((line) => line.text),
			["hello", "again"],
		);
	});

	const NOT_LINES: Record<string, string> = {
		null: "null",
		"a number": "5",
		"a string": '"x"',
		"a list": "[]",
		"an empty object": "{}",
		"a line with no text": JSON.stringify({ ts: 1, kind: "text" }),
		"a line of an unknown kind": JSON.stringify({ ts: 1, kind: "rm -rf", text: "x" }),
		"a line whose text is an object": JSON.stringify({ ts: 1, kind: "text", text: { a: 1 } }),
		"a line with no time": JSON.stringify({ kind: "text", text: "x" }),
	};

	for (const [name, line] of Object.entries(NOT_LINES)) {
		it(`drops ${name}, so nothing that reads the mirror meets a null or a missing field`, () => {
			assert.deepEqual(
				mirror([JSON.stringify(GOOD), line]).map((entry) => entry.text),
				["hello"],
			);
		});
	}

	it("reads nothing from a mirror that does not exist", () => {
		assert.deepEqual(readMirror(dir, "no-such-session"), []);
	});
});
