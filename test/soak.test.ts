// `npm run soak` runs copies of test files side by side and must tell a pass from a failure from a hang, and say which run to read.
// Each case runs the script against a small fixture repository whose test files pass, fail or never exit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SOAK = fileURLToPath(new URL("../scripts/soak.ts", import.meta.url));
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const PASS = 'import { test } from "node:test";\ntest("ok", () => {});\n';
const FAIL = 'import { test } from "node:test";\ntest("breaks", () => {\n\tthrow new Error("boom");\n});\n';
/** Passes its test and then keeps the process alive for ever, as a leaked timer does. */
const HANG = 'import { test } from "node:test";\ntest("ok", () => {});\nsetInterval(() => {}, 1000);\n';

function soak(files: Record<string, string>, args: string[] = [], env: Record<string, string> = {}): { status: number | null; output: string } {
	const root = mkdtempSync(join(tmpdir(), "soak-fixture-"));
	made.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const result = spawnSync(process.execPath, [SOAK, ...args], { env: { ...process.env, ...env, REPO_CHECK_ROOT: root }, encoding: "utf8", timeout: 60_000 });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const tui = (name: string, content: string, pkg = "pi-demo") => ({ [`packages/${pkg}/test/tui/${name}.test.ts`]: content });
const unit = (name: string, content: string, pkg = "pi-demo") => ({ [`packages/${pkg}/test/unit/${name}.test.ts`]: content });
/** Passes in the order it is written, fails when its second test runs first: the order dependence a random order exists to find. */
const ORDER_DEPENDENT = `import assert from "node:assert/strict";
import { test } from "node:test";
let ready = false;
test("sets up", () => {
	ready = true;
});
test("needs the set up", () => {
	assert.equal(ready, true);
});
`;

describe("soak", () => {
	test("passes when every copy of every suite passes, and says how many ran", () => {
		const result = soak({ ...tui("a", PASS), ...tui("b", PASS) }, ["--copies", "2"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /soak: 4 runs \(2 files x 2 copies\)/);
		assert.match(result.output, /pass {2}packages\/pi-demo\/test\/tui\/a\.test\.ts {2}2\/2 passed/);
		assert.match(result.output, /pass {2}packages\/pi-demo\/test\/tui\/b\.test\.ts {2}2\/2 passed/);
		assert.doesNotMatch(result.output, /first failing run/);
	});

	test("fails on a failing suite, names the file and the log to read, and shows what failed", () => {
		const result = soak({ ...tui("good", PASS), ...tui("bad", FAIL) }, ["--copies", "2"]);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /pass {2}packages\/pi-demo\/test\/tui\/good\.test\.ts {2}2\/2 passed/);
		assert.match(result.output, /FAIL {2}packages\/pi-demo\/test\/tui\/bad\.test\.ts {2}0\/2 passed, 2 failed, 0 hung/);
		assert.match(result.output, /first failing run: \S+bad\.test\.ts-\d\.log/);
		assert.match(result.output, /boom/);
	});

	test("kills a suite that passes and never exits, and counts it as a hang rather than a pass", () => {
		const result = soak({ ...tui("hangs", HANG) }, ["--copies", "1", "--timeout", "2"]);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /FAIL {2}packages\/pi-demo\/test\/tui\/hangs\.test\.ts {2}0\/1 passed, 0 failed, 1 hung/);
		assert.match(result.output, /did not exit before the timeout and was killed/);
	});

	test("runs the test/tui suites of the package a target names, and no others", () => {
		const files = { ...tui("mine", PASS), ...tui("theirs", FAIL, "pi-other") };
		const byName = soak(files, ["pi-demo", "--copies", "1"]);
		assert.equal(byName.status, 0, byName.output);
		assert.doesNotMatch(byName.output, /pi-other/);
		const byPath = soak(files, ["packages/pi-demo", "--copies", "1"]);
		assert.equal(byPath.status, 0, byPath.output);
	});

	test("runs a test file a target names, from the folder of its package", () => {
		const result = soak({ ...tui("one", PASS), ...tui("two", FAIL) }, ["packages/pi-demo/test/tui/one.test.ts", "--copies", "1"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /soak: 1 runs \(1 files x 1 copies\)/);
	});

	test("runs every package's suites when no target is named", () => {
		const result = soak({ ...tui("a", PASS), ...tui("b", PASS, "pi-other") }, ["--copies", "1"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /packages\/pi-demo\/test\/tui\/a\.test\.ts/);
		assert.match(result.output, /packages\/pi-other\/test\/tui\/b\.test\.ts/);
	});

	test("is a usage error, with the usage, for an unknown option, a bad number, an unknown target or nothing to run", () => {
		const cases: Array<[string[], RegExp, Record<string, string>?]> = [
			[["--nope"], /unknown option --nope/],
			[["--copies", "0"], /--copies needs a whole number of at least 1/],
			[["--timeout", "soon"], /--timeout needs a whole number of at least 1/],
			[["missing"], /missing is neither a test file nor a package/],
			[[], /there are no test files to run/, { "packages/pi-demo/package.json": "{}\n" }],
		];
		for (const [args, message, files] of cases) {
			const result = soak(files ?? tui("a", PASS), args);
			assert.equal(result.status, 2, `${args.join(" ")}: ${result.output}`);
			assert.match(result.output, message);
			assert.match(result.output, /usage: npm run soak/);
		}
	});
});

describe("soak --randomize", () => {
	test("leaves the order alone without the flag, so an order-dependent suite passes", () => {
		const result = soak({ ...tui("ordered", ORDER_DEPENDENT) }, ["--copies", "12"]);
		assert.equal(result.status, 0, result.output);
		assert.doesNotMatch(result.output, /random order/);
	});

	test("runs each copy in its own seeded random order, says which seed, and finds an order-dependent suite", () => {
		const result = soak({ ...tui("ordered", ORDER_DEPENDENT) }, ["--randomize", "--copies", "30"], { SOAK_SEED: "1" });
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /random order, seeds 1 to 30 \(replay a run with SOAK_SEED=<its seed> and --copies 1\)/);
		assert.match(result.output, /first failing run: \S+ \(seed \d+\)/);
	});

	test("gives every copy an order of its own: an order-dependent suite passes in some copies and fails in others", () => {
		const result = soak({ ...tui("ordered", ORDER_DEPENDENT) }, ["--randomize", "--copies", "30"], { SOAK_SEED: "1" });
		const passed = Number(/(\d+)\/30 passed/.exec(result.output)?.[1]);
		// one shared seed would make all thirty copies do the same thing; thirty seeds make a mix, with a chance of 2^-29 of none
		assert.ok(passed > 0 && passed < 30, `${passed} of 30 copies passed\n${result.output}`);
	});

	test("replays: the same seed gives the same first failing run", () => {
		const args = ["--randomize", "--copies", "30"];
		const first = soak({ ...tui("ordered", ORDER_DEPENDENT) }, args, { SOAK_SEED: "1" });
		const second = soak({ ...tui("ordered", ORDER_DEPENDENT) }, args, { SOAK_SEED: "1" });
		const seed = (output: string) => /first failing run: \S+ \(seed (\d+)\)/.exec(output)?.[1];
		assert.ok(seed(first.output), first.output);
		assert.equal(seed(second.output), seed(first.output));
		const alone = soak({ ...tui("ordered", ORDER_DEPENDENT) }, ["--randomize", "--copies", "1"], { SOAK_SEED: seed(first.output) as string });
		assert.equal(alone.status, 1, "the seed on its own reproduces the failure");
	});

	test("passes a suite whose tests do not depend on each other, under any order", () => {
		const result = soak({ ...tui("independent", PASS) }, ["--randomize", "--copies", "6"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /random order, seeds \d+ to \d+/);
	});

	test("refuses a seed that is not a whole number", () => {
		const result = soak({ ...tui("a", PASS) }, ["--randomize"], { SOAK_SEED: "abc" });
		assert.equal(result.status, 2, result.output);
		assert.match(result.output, /SOAK_SEED must be a whole number/);
	});
});

describe("soak --suites", () => {
	const files = { ...tui("fine", PASS), ...unit("broken", FAIL) };

	test("runs the test/tui suites of a package by default, as before", () => {
		const result = soak(files, ["pi-demo", "--copies", "1"]);
		assert.equal(result.status, 0, result.output);
	});

	test("runs the suites it names, so unit tests can be shaken too", () => {
		const result = soak(files, ["pi-demo", "--copies", "1", "--suites", "unit,tui"]);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /FAIL {2}packages\/pi-demo\/test\/unit\/broken\.test\.ts/);
		assert.match(result.output, /pass {2}packages\/pi-demo\/test\/tui\/fine\.test\.ts/);
	});

	test("refuses a suite it does not know", () => {
		const result = soak(files, ["pi-demo", "--suites", "e2e"]);
		assert.equal(result.status, 2, result.output);
		assert.match(result.output, /--suites takes unit, integration and tui, not "e2e"/);
	});
});
