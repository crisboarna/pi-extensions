// Runs several copies of test files at the same time, to find the failures and the hangs that only show on a busy machine.
//
// A test that waits for a screen, a timer or a child process can pass a hundred times alone and fail once beside eleven others; a suite can
// pass every test and then never exit. Run this on what you wrote or changed before you push it:
//
//   npm run soak                                  every test/tui suite of every package, 4 copies each
//   npm run soak -- pi-context-refs               the test/tui suites of one package
//   npm run soak -- packages/pi-switchboard/test/tui/tier-editor-keys.test.ts --copies 24 --parallel 12
//
// It prints one line per file, the folder with every run's log, and the failing lines of the first failing log. A run that does not exit
// within the timeout is killed and counted as a hang. The exit code is 1 when any run fails or hangs, 2 for a usage error.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runNodeTest } from "./lib/node-test.ts";
import { ROOT } from "./lib/repo.ts";

const USAGE = "usage: npm run soak -- [--copies N] [--parallel N] [--timeout SECONDS] [test file | package]...";

interface Options {
	copies: number;
	parallel: number;
	timeoutSeconds: number;
	targets: string[];
}

interface Job {
	/** The test file, relative to the repository. */
	file: string;
	copy: number;
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
	const options: Options = { copies: 4, parallel: availableParallelism(), timeoutSeconds: 120, targets: [] };
	const numeric: Record<string, "copies" | "parallel" | "timeoutSeconds"> = { "--copies": "copies", "--parallel": "parallel", "--timeout": "timeoutSeconds" };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		const key = numeric[arg];
		if (key) {
			const value = Number(args[++index]);
			if (!Number.isInteger(value) || value < 1) usageError(`${arg} needs a whole number of at least 1`);
			options[key] = value;
		} else if (arg.startsWith("--")) usageError(`unknown option ${arg}`);
		else options.targets.push(arg);
	}
	return options;
}

/** The `test/tui` suites of a package folder, relative to the repository. */
function tuiSuites(packageDir: string): string[] {
	const dir = join(ROOT, packageDir, "test", "tui");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".test.ts"))
		.sort()
		.map((name) => `${packageDir}/test/tui/${name}`);
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
	if (packageDir) return tuiSuites(packageDir);
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
const files = [...new Set(options.targets.length > 0 ? options.targets.flatMap(filesOf) : allPackages().flatMap(tuiSuites))];
if (files.length === 0) usageError("there are no test files to run");
const jobs: Job[] = files.flatMap((file) => Array.from({ length: options.copies }, (_, copy) => ({ file, copy: copy + 1 })));
const logs = mkdtempSync(join(tmpdir(), "soak-"));
console.log(
	`soak: ${jobs.length} runs (${files.length} files x ${options.copies} copies), ${options.parallel} at a time, ${options.timeoutSeconds} s each; logs in ${logs}`,
);

const outcomes: Outcome[] = [];
await pool(jobs, options.parallel, async (job) => {
	const packageDir = packageOf(job.file);
	const log = join(logs, `${job.file.replace(/[^\w.-]+/g, "_")}-${job.copy}.log`);
	const run = await runNodeTest({
		cwd: join(ROOT, packageDir),
		files: [relative(packageDir, job.file)],
		timeoutMs: options.timeoutSeconds * 1000,
		logPath: log,
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
	console.log(`\nfirst failing run: ${firstFailure.log}${firstFailure.hung ? " (it did not exit before the timeout and was killed)" : ""}`);
	for (const line of failingLines(firstFailure.log)) console.log(`  ${line.trim().slice(0, 200)}`);
}
process.exit(failed ? 1 : 0);
