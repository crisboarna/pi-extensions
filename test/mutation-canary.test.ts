// `npm run mutation-canary` breaks a line of source on purpose and expects the named tests to fail. It must call a mutation killed only
// when the tests fail and a survivor only when they pass, refuse to touch a file with uncommitted work, and always put the file back.
// Each case runs the script against a small git fixture whose one test guards one function.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CANARY = fileURLToPath(new URL("../scripts/mutation-canary.ts", import.meta.url));
// Run from the pre-push hook, the fixture's git commands would act on the repository being pushed, so drop what hooks export.
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = "export const add = (a: number, b: number): number => a + b;\nexport const unused = 1;\n";
const TEST =
	'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/add.ts";\ntest("adds", () => {\n\tassert.equal(add(2, 3), 5);\n});\n';
const FILE = "packages/pi-demo/src/add.ts";
const TESTS = ["packages/pi-demo/test/add.test.ts"];
const FLIP = { id: "add-flips-sign", file: FILE, find: "a + b", replace: "a - b", tests: TESTS };

/** A committed fixture repository with one source file, one test and the given mutations. */
function fixture(mutations: unknown, files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "canary-fixture-"));
	made.push(root);
	const all = { [FILE]: SOURCE, [TESTS[0] as string]: TEST, "scripts/mutations/demo.json": JSON.stringify(mutations), ...files };
	for (const [path, content] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "fixture");
	return root;
}

const canary = (root: string, args: string[] = []): { status: number | null; output: string } => {
	const result = spawnSync(process.execPath, [CANARY, ...args], {
		cwd: root,
		env: { ...process.env, REPO_CHECK_ROOT: root },
		encoding: "utf8",
		timeout: 90_000,
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
};
const read = (root: string, path = FILE): string => readFileSync(join(root, path), "utf8");
const clean = (root: string): string => execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });

describe("mutation-canary", () => {
	test("calls a mutation killed when the tests fail with it, and puts the file back as it was", () => {
		const root = fixture([FLIP]);
		const result = canary(root);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /killed {4}add-flips-sign/);
		assert.match(result.output, /1 killed, 0 survived, 0 could not be checked/);
		assert.equal(read(root), SOURCE);
		assert.equal(clean(root), "", "the tree is as committed");
	});

	test("calls a mutation that the tests do not notice a survivor, says what was changed, and fails", () => {
		const root = fixture([{ id: "unused-changes", file: FILE, find: "export const unused = 1;", replace: "export const unused = 2;", tests: TESTS }]);
		const result = canary(root);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /SURVIVED {2}unused-changes {2}the tests still pass with this change to packages\/pi-demo\/src\/add\.ts/);
		assert.match(result.output, /export const unused = 1;/);
		assert.match(result.output, /-> export const unused = 2;/);
		assert.match(result.output, /0 killed, 1 survived/);
		assert.equal(read(root), SOURCE);
	});

	test("counts a mutation that makes the tests never exit as killed, because the tests did notice", () => {
		const root = fixture([{ ...FLIP, id: "add-never-returns", replace: "(() => { for (;;) {} })()" }]);
		const result = canary(root, ["--timeout", "2"]);
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /killed {4}add-never-returns/);
		assert.equal(read(root), SOURCE);
	});

	test("refuses a file with uncommitted changes and leaves it as it is", () => {
		const root = fixture([FLIP]);
		const edited = `${SOURCE}// my work in progress\n`;
		writeFileSync(join(root, FILE), edited);
		const result = canary(root);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /ERROR {5}add-flips-sign {2}packages\/pi-demo\/src\/add\.ts has uncommitted changes/);
		assert.equal(read(root), edited);
	});

	test("refuses a find that does not match exactly once", () => {
		const none = canary(fixture([{ ...FLIP, find: "a * b" }]));
		assert.equal(none.status, 1, none.output);
		assert.match(none.output, /"find" matches 0 times in packages\/pi-demo\/src\/add\.ts; it must match exactly once/);
		const twice = canary(fixture([{ ...FLIP, find: "export const" }]));
		assert.equal(twice.status, 1, twice.output);
		assert.match(twice.output, /"find" matches 2 times/);
	});

	test("refuses to count a failure when the tests already fail without the break", () => {
		const failing = TEST.replace("add(2, 3), 5", "add(2, 3), 6");
		const root = fixture([FLIP], { [TESTS[0] as string]: failing });
		const result = canary(root);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /ERROR {5}add-flips-sign {2}the tests fail without the break .*so a failure would prove nothing/);
		assert.equal(read(root), SOURCE);
	});

	test("refuses tests that are not files of the mutated file's package", () => {
		const result = canary(fixture([{ ...FLIP, tests: ["packages/pi-other/test/add.test.ts"] }]));
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /its tests must be existing files of packages\/pi-demo/);
	});

	test("puts the file back when it is stopped with SIGINT while the tests run", async () => {
		const slowWhenBroken = `import { readFileSync } from "node:fs";\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.ts";\ntest("adds", async () => {\n\tif (readFileSync(new URL("../src/add.ts", import.meta.url), "utf8").includes("a - b")) await new Promise((resolve) => setTimeout(resolve, 60000));\n\tassert.equal(add(2, 3), 5);\n});\n`;
		const root = fixture([FLIP], { [TESTS[0] as string]: slowWhenBroken });
		const child = spawn(process.execPath, [CANARY], { cwd: root, env: { ...process.env, REPO_CHECK_ROOT: root }, stdio: "ignore" });
		const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
		const deadline = Date.now() + 30_000;
		while (!read(root).includes("a - b") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(read(root).includes("a - b"), "the break was in place while the tests ran");
		child.kill("SIGINT");
		assert.equal(await exited, 130);
		assert.equal(read(root), SOURCE, "the file was put back");
		assert.equal(clean(root), "");
	});

	test("lists the ids, and runs only the ones --only names", () => {
		const second = { ...FLIP, id: "second", find: "export const unused = 1;", replace: "export const unused = 2;" };
		const root = fixture([FLIP, second]);
		const listed = canary(root, ["--list"]);
		assert.equal(listed.status, 0, listed.output);
		assert.equal(listed.output.trim().split("\n").join(" "), "add-flips-sign second");
		const only = canary(root, ["--only", "add-flips-sign"]);
		assert.equal(only.status, 0, only.output);
		assert.match(only.output, /1 mutations/);
		assert.doesNotMatch(only.output, /second/);
	});

	test("is a usage error, with the usage, for a bad option, an unknown id, a repeated id or a malformed entry", () => {
		const cases: Array<[unknown, string[], RegExp]> = [
			[[FLIP], ["--nope"], /unknown option --nope/],
			[[FLIP], ["--only", "missing"], /there is no mutation with the id "missing"/],
			[[FLIP], ["--timeout", "0"], /--timeout needs a whole number of at least 1/],
			[[FLIP, FLIP], [], /the id "add-flips-sign" is used twice/],
			[[{ ...FLIP, tests: [] }], [], /"tests" must be a list of test files/],
			[[{ ...FLIP, find: 3 }], [], /"find" must be a string/],
			[{ not: "an array" }, [], /must hold an array of mutations/],
		];
		for (const [mutations, args, message] of cases) {
			const result = canary(fixture(mutations), args);
			assert.equal(result.status, 2, `${args.join(" ")}: ${result.output}`);
			assert.match(result.output, message);
			assert.match(result.output, /usage: npm run mutation-canary/);
		}
	});
});
