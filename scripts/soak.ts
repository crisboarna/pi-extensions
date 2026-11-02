// Runs several copies of test files at the same time, to find the failures and the hangs that only show on a busy machine.
//
// A test that waits for a screen, a timer or a child process can pass a hundred times alone and fail once beside eleven others; a suite can
// pass every test and then never exit. Run this on what you wrote or changed before you push it:
//
//   npm run soak                                  every test/tui suite of every package, 4 copies each
//   npm run soak -- pi-context-refs               the test/tui suites of one package
//   npm run soak -- packages/pi-switchboard/test/tui/tier-editor-keys.test.ts --copies 24 --parallel 12
//   npm run soak -- --randomize --suites unit,integration,tui --copies 3     run every test in a random order, to find tests that depend on each other
//   SOAK_SEED=1234 npm run soak -- --randomize --copies 1 <test file>        replay the order a failing run printed
//
// It prints one line per file, the folder with every run's log, and the failing lines of the first failing log. A run that does not exit
// within the timeout is killed and counted as a hang. The exit code is 1 when any run fails or hangs, 2 for a usage error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runNodeTest } from "./lib/node-test.ts";
import { ROOT } from "./lib/repo.ts";

const USAGE = "usage: npm run soak -- [--copies N] [--parallel N] [--timeout SECONDS] [--randomize] [--suites unit,integration,tui] [test file | package]...";
const SUITES = ["unit", "integration", "tui"];

interface Options {
	/** Run each copy in a random test order, seeded; Node 24 has the flag, Node 22 does not. */
	randomize: boolean;
	/** The folders of test/ that a package target runs. */
	suites: string[];
	copies: number;
	parallel: number;
	timeoutSeconds: number;
	targets: string[];
}

interface Job {
	/** The test file, relative to the repository. */
	file: string;
	copy: number;
	/** The seed of this copy's random order, when the run is randomized. */
	seed?: number;
}

interface Outcome {
	job: Job;
	log: string;
	exitCode: number | undefined;
	hung: boolean;
}

function usageError(message: string): never {
	console.error(`soak: ${message}\n${USAGE}`);
	process.exit(2);
}

function parseArgs(args: string[]): Options {
	const options: Options = { randomize: false, suites: ["tui"], copies: 4, parallel: availableParallelism(), timeoutSeconds: 120, targets: [] };
	const numeric: Record<string, "copies" | "parallel" | "timeoutSeconds"> = { "--copies": "copies", "--parallel": "parallel", "--timeout": "timeoutSeconds" };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		const key = numeric[arg];
		if (key) {
			const value = Number(args[++index]);
			if (!Number.isInteger(value) || value < 1) usageError(`${arg} needs a whole number of at least 1`);
			options[key] = value;
		} else if (arg === "--randomize") options.randomize = true;
		else if (arg === "--suites") {
			const names = (args[++index] ?? "").split(",").filter(Boolean);
			const unknown = names.find((name) => !SUITES.includes(name));
			if (names.length === 0 || unknown !== undefined) usageError(`--suites takes unit, integration and tui, not "${unknown ?? ""}"`);
			options.suites = names;
		} else if (arg.startsWith("--")) usageError(`unknown option ${arg}`);
		else options.targets.push(arg);
	}
	return options;
}

/** The test files of a package folder in the suites `--suites` names (test/tui by default), relative to the repository. */
function suiteFiles(packageDir: string): string[] {
	return options.suites.flatMap((suite) => {
		const dir = join(ROOT, packageDir, "test", suite);
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".test.ts"))
			.sort()
			.map((name) => `${packageDir}/test/${suite}/${name.split("\\").join("/")}`);
	});
}

function allPackages(): string[] {
	const dir = join(ROOT, "packages");
	return existsSync(dir)
		? readdirSync(dir)
				.sort()
				.map((name) => `packages/${name}`)
		: [];
}

/** The test files a target names: a test file, a package folder or a package's name. */
function filesOf(target: string): string[] {
	const path = resolve(ROOT, target);
	if (existsSync(path) && statSync(path).isFile()) return [relative(ROOT, path).split("\\").join("/")];
	const packageDir = allPackages().find((dir) => dir === target.replace(/\/$/, "") || dir === `packages/${target}`);
	if (packageDir) return suiteFiles(packageDir);
	return usageError(`${target} is neither a test file nor a package`);
}

/** The package folder of a test file, which is where it runs. */
function packageOf(file: string): string {
	const [packages, name] = file.split("/");
	if (packages !== "packages" || !name) usageError(`${file} is not inside a package folder`);
	return `packages/${name}`;
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const item = items[next++];
			if (item === undefined) return;
			await work(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The lines of a log that say what failed. */
function failingLines(log: string): string[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => /✖|AssertionError|Error:|timed out/.test(line))
		.slice(0, 12);
}

const options = parseArgs(process.argv.slice(2));
const files = [...new Set(options.targets.length > 0 ? options.targets.flatMap(filesOf) : allPackages().flatMap(suiteFiles))];
if (files.length === 0) usageError("there are no test files to run");
/** The seed of the first copy: SOAK_SEED to replay a run, else any number. Each later copy adds one, so every copy has an order of its own. */
function firstSeed(): number {
	const given = process.env.SOAK_SEED;
	if (given === undefined) return Math.floor(Math.random() * 2 ** 31);
	const seed = Number(given);
	if (given.trim() === "" || !Number.isInteger(seed) || seed < 0) usageError("SOAK_SEED must be a whole number");
	return seed;
}
if (options.randomize && spawnSync(process.execPath, ["--test-randomize", "-e", ""], { stdio: "ignore" }).status !== 0)
	usageError("this Node has no --test-randomize; use Node 24");
const baseSeed = options.randomize ? firstSeed() : 0;
const jobs: Job[] = files.flatMap((file) =>
	Array.from({ length: options.copies }, (_, copy) => ({ file, copy: copy + 1, ...(options.randomize ? { seed: baseSeed + copy } : {}) })),
);
const logs = mkdtempSync(join(tmpdir(), "soak-"));
console.log(
	`soak: ${jobs.length} runs (${files.length} files x ${options.copies} copies), ${options.parallel} at a time, ${options.timeoutSeconds} s each; logs in ${logs}`,
);
if (options.randomize)
	console.log(`soak: random order, seeds ${baseSeed} to ${baseSeed + options.copies - 1} (replay a run with SOAK_SEED=<its seed> and --copies 1)`);

const outcomes: Outcome[] = [];
await pool(jobs, options.parallel, async (job) => {
	const packageDir = packageOf(job.file);
	const log = join(logs, `${job.file.replace(/[^\w.-]+/g, "_")}-${job.copy}.log`);
	const run = await runNodeTest({
		cwd: join(ROOT, packageDir),
		files: [relative(packageDir, job.file)],
		timeoutMs: options.timeoutSeconds * 1000,
		logPath: log,
		args: job.seed === undefined ? [] : ["--test-randomize", `--test-random-seed=${job.seed}`],
	});
	outcomes.push({ job, log, exitCode: run.exitCode, hung: run.hung });
});

let failed = false;
let firstFailure: Outcome | undefined;
for (const file of files) {
	const mine = outcomes.filter((outcome) => outcome.job.file === file);
	const hung = mine.filter((outcome) => outcome.hung);
	const failures = mine.filter((outcome) => !outcome.hung && outcome.exitCode !== 0);
	const bad = [...failures, ...hung];
	firstFailure ??= bad[0];
	failed ||= bad.length > 0;
	const summary =
		bad.length === 0
			? `${mine.length}/${mine.length} passed`
			: `${mine.length - bad.length}/${mine.length} passed, ${failures.length} failed, ${hung.length} hung`;
	console.log(`${bad.length === 0 ? "pass" : "FAIL"}  ${file}  ${summary}`);
}
if (firstFailure) {
	const seed = firstFailure.job.seed === undefined ? "" : ` (seed ${firstFailure.job.seed})`;
	console.log(`\nfirst failing run: ${firstFailure.log}${seed}${firstFailure.hung ? " (it did not exit before the timeout and was killed)" : ""}`);
	for (const line of failingLines(firstFailure.log)) console.log(`  ${line.trim().slice(0, 200)}`);
}
process.exit(failed ? 1 : 0);
