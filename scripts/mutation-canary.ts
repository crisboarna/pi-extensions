// Checks that the tests can fail. A test that cannot fail proves nothing, and a keystroke test is easy to write that way: it presses a key,
// waits for something that is always on the screen, and passes.
//
// Each entry of scripts/mutations/*.json breaks one line of a source file on purpose and names the tests that must notice. This script
// applies the break, runs those tests, and puts the file back; the tests must fail, or the mutation "survived" and the tests are not
// guarding what they claim to. An entry is `{ id, file, find, replace, tests }`: `find` must occur exactly once in `file`, and `tests` are
// test files of the same package. Add an entry whenever you prove a test by hand, so that the proof does not have to be done again.
//
//   npm run mutation-canary                      every entry
//   npm run mutation-canary -- --only approval-once-allows-everything,tier-save-ignores-no
//   npm run mutation-canary -- --list            the ids
//
// It cannot lose your work. It refuses a file with uncommitted changes, runs the tests without the break first (a failure only proves
// something if they pass without it), restores the file in a `finally` and on SIGINT and SIGTERM, and checks the restored file's hash.
// The exit code is 1 when a mutation survives or an entry cannot be checked, 2 for a usage error or a malformed entry.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { killRunningTests, runNodeTest } from "./lib/node-test.ts";
import { ROOT, readJson } from "./lib/repo.ts";

const USAGE = "usage: npm run mutation-canary -- [--list] [--only ID[,ID]...] [--timeout SECONDS]";

interface Mutation {
	id: string;
	file: string;
	find: string;
	replace: string;
	tests: string[];
}

type Verdict = { kind: "killed"; seconds: number } | { kind: "survived" } | { kind: "error"; message: string };

function usageError(message: string): never {
	console.error(`mutation-canary: ${message}\n${USAGE}`);
	process.exit(2);
}

/** Every entry of every file under scripts/mutations, checked for its shape. */
function loadMutations(): Mutation[] {
	const dir = join(ROOT, "scripts", "mutations");
	const files = existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.endsWith(".json"))
				.sort()
		: [];
	const found: Mutation[] = [];
	for (const name of files) {
		const entries = readJson<unknown>(join(dir, name));
		if (!Array.isArray(entries)) usageError(`scripts/mutations/${name} must hold an array of mutations`);
		for (const [index, entry] of entries.entries()) {
			const where = `scripts/mutations/${name}[${index}]`;
			const m = entry as Partial<Mutation> | null;
			for (const key of ["id", "file", "find", "replace"] as const) if (typeof m?.[key] !== "string") usageError(`${where}: "${key}" must be a string`);
			if (!(Array.isArray(m?.tests) && m.tests.length > 0 && m.tests.every((test) => typeof test === "string")))
				usageError(`${where}: "tests" must be a list of test files`);
			if (found.some((other) => other.id === m?.id)) usageError(`${where}: the id "${m?.id}" is used twice`);
			found.push(m as Mutation);
		}
	}
	return found;
}

/** The folder a mutation's tests run in: its package, or the repository for a file outside the packages. */
function packageOf(file: string): string {
	const [packages, name] = file.split("/");
	return packages === "packages" && name ? `packages/${name}` : "";
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The files that hold a break right now, with their text, for the handlers that must put them back. */
const broken = new Map<string, string>();

function restoreAll(): void {
	for (const [path, text] of broken) writeFileSync(path, text);
	broken.clear();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		killRunningTests();
		restoreAll();
		process.exit(130);
	});
}
process.on("exit", restoreAll);

function dirty(file: string): boolean {
	return execFileSync("git", ["status", "--porcelain", "--", file], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
}

const options = { list: false, only: [] as string[], timeoutSeconds: 300 };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	if (arg === "--list") options.list = true;
	else if (arg === "--only") options.only = (args[++index] ?? "").split(",").filter(Boolean);
	else if (arg === "--timeout") {
		options.timeoutSeconds = Number(args[++index]);
		if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1) usageError("--timeout needs a whole number of at least 1");
	} else usageError(`unknown option ${arg}`);
}

const all = loadMutations();
for (const id of options.only) if (!all.some((mutation) => mutation.id === id)) usageError(`there is no mutation with the id "${id}"`);
const chosen = options.only.length > 0 ? all.filter((mutation) => options.only.includes(mutation.id)) : all;
if (options.list) {
	for (const mutation of all) console.log(mutation.id);
	process.exit(0);
}
if (chosen.length === 0) usageError("there are no mutations to check");

const logs = mkdtempSync(join(tmpdir(), "mutation-canary-"));
const baselines = new Map<string, Promise<{ ok: boolean; log: string }>>();

/** Runs the mutation's tests as they are now. */
function runTests(mutation: Mutation, label: string): ReturnType<typeof runNodeTest> {
	const cwd = join(ROOT, packageOf(mutation.file));
	return runNodeTest({
		cwd,
		files: mutation.tests.map((test) => relative(cwd, join(ROOT, test))),
		timeoutMs: options.timeoutSeconds * 1000,
		logPath: join(logs, `${mutation.id}-${label}.log`),
	});
}

/** Whether the tests pass without any break, once for each set of tests. */
function baseline(mutation: Mutation): Promise<{ ok: boolean; log: string }> {
	const key = `${packageOf(mutation.file)}\n${mutation.tests.join("\n")}`;
	let result = baselines.get(key);
	if (!result) {
		result = runTests(mutation, "baseline").then((run) => ({ ok: run.exitCode === 0, log: join(logs, `${mutation.id}-baseline.log`) }));
		baselines.set(key, result);
	}
	return result;
}

/** Why a mutation cannot be checked, or undefined when it can. */
function problemWith(mutation: Mutation, original: string): string | undefined {
	const pkg = packageOf(mutation.file);
	if (mutation.tests.some((test) => !test.startsWith(pkg ? `${pkg}/` : "") || !existsSync(join(ROOT, test))))
		return `its tests must be existing files of ${pkg || "the repository"}`;
	const count = original.split(mutation.find).length - 1;
	if (count !== 1) return `"find" matches ${count} times in ${mutation.file}; it must match exactly once`;
	try {
		if (dirty(mutation.file)) return `${mutation.file} has uncommitted changes; commit or stash them first, so that nothing of yours can be lost`;
	} catch (error) {
		return `cannot tell whether ${mutation.file} is committed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
	}
	return undefined;
}

async function check(mutation: Mutation): Promise<Verdict> {
	const path = join(ROOT, mutation.file);
	if (!existsSync(path)) return { kind: "error", message: `${mutation.file} does not exist` };
	const original = readFileSync(path, "utf8");
	const problem = problemWith(mutation, original);
	if (problem) return { kind: "error", message: problem };
	const base = await baseline(mutation);
	if (!base.ok) return { kind: "error", message: `the tests fail without the break (see ${base.log}), so a failure would prove nothing` };
	broken.set(path, original);
	let run: Awaited<ReturnType<typeof runTests>>;
	try {
		writeFileSync(
			path,
			original.replace(mutation.find, () => mutation.replace),
		);
		run = await runTests(mutation, "mutated");
	} finally {
		writeFileSync(path, original);
		broken.delete(path);
	}
	if (sha(readFileSync(path, "utf8")) !== sha(original)) {
		console.error(`mutation-canary: ${mutation.file} did not come back as it was; restore it with git`);
		process.exit(1);
	}
	return run.exitCode === 0 ? { kind: "survived" } : { kind: "killed", seconds: Math.round(run.milliseconds / 100) / 10 };
}

console.log(`mutation-canary: ${chosen.length} mutations; logs in ${logs}`);
const counts = { killed: 0, survived: 0, error: 0 };
for (const mutation of chosen) {
	const verdict = await check(mutation);
	counts[verdict.kind]++;
	if (verdict.kind === "killed") console.log(`killed    ${mutation.id}  (${verdict.seconds} s)`);
	else if (verdict.kind === "survived") {
		console.log(`SURVIVED  ${mutation.id}  the tests still pass with this change to ${mutation.file}:`);
		console.log(`            ${mutation.find.trim().slice(0, 160)}\n         -> ${mutation.replace.trim().slice(0, 160) || "(removed)"}`);
		console.log(`            tests: ${mutation.tests.join(", ")}`);
	} else console.log(`ERROR     ${mutation.id}  ${verdict.message}`);
}
console.log(`\n${counts.killed} killed, ${counts.survived} survived, ${counts.error} could not be checked`);
process.exit(counts.survived + counts.error > 0 ? 1 : 0);
