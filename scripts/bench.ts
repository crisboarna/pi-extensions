// Latency gate: times what a user waits for, on the base and the head of a change, and says whether the head is slower in a way noise does not explain.
//
//   node scripts/bench.ts [--head <dir>] [--base <dir>] [--samples 30] [--only <name>] [--write <dir>] [--json <file>] [--fail]
//
// Two things are timed. `load`: how long real pi takes, from its start to answering `get_commands`, with each package's extension loaded. `route`: how long
// pi-switchboard's rule evaluation takes over its 24 calibration requests. With --base, samples of the two trees are taken alternately on this one machine,
// so a busy moment hits both, and a result is a regression only when the rank test, the relative slowdown and the absolute slowdown all say so (see
// scripts/lib/stats.ts). A flagged benchmark is measured once more and must be flagged again, so one noisy run cannot fail a change.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { listPackages, ROOT } from "./lib/repo.ts";
import { type Comparison, compareTimings, median, type Thresholds } from "./lib/stats.ts";

const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const WARMUP = 2;
const REPEATS_PER_ROUTE_SAMPLE = 200;
const CALIBRATION_CASES = (
	JSON.parse(readFileSync(join(ROOT, "packages", "pi-switchboard", "test", "fixtures", "h2o-calibration.json"), "utf8")) as { cases: unknown[] }
).cases.length;

interface Bench {
	package: string;
	name: string;
	method: string;
	thresholds: Thresholds;
	/** How many decisions one sample covers, when it is a batch of them; the page for the benchmark divides by it. */
	perSample?: number;
	/** One timing, in milliseconds, of the tree at `root`. */
	run(root: string): Promise<number>;
}

/** Real pi, started on an empty agent directory with this package's extension loaded, until it answers `get_commands`. */
function loadTime(root: string, packageDir: string | undefined): Promise<number> {
	return new Promise((resolveTime, reject) => {
		const home = mkdtempSync(join(tmpdir(), "bench-"));
		const extensionArguments = packageDir === undefined ? [] : ["-e", join(root, "packages", packageDir, "src", "index.ts")];
		const started = performance.now();
		const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--no-session", "--offline", "-ne", ...extensionArguments], {
			cwd: home,
			env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let pending = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${packageDir ?? "pi alone"}: pi did not answer get_commands in 60 s\n${stderr}`));
		}, 60_000);
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		child.stdout.on("data", (data) => {
			pending += String(data);
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			if (!lines.some((line) => line.includes('"command":"get_commands"'))) return;
			const elapsed = performance.now() - started;
			clearTimeout(timer);
			child.kill();
			resolveTime(elapsed);
		});
		child.on("error", reject);
		child.stdin.write(`${JSON.stringify({ id: "bench", type: "get_commands" })}\n`);
	});
}

interface RuleModules {
	questions: { BUILTIN_QUESTIONS: unknown };
	builtin: { BUILTIN_RULESET: unknown };
	evaluate: { evaluateRules: (profile: unknown, questions: unknown, answers: unknown, signals: unknown, threshold: number) => unknown };
}

/** pi-switchboard's rule evaluation over its calibration requests, run `REPEATS_PER_ROUTE_SAMPLE` times, taken from the tree at `root`. */
async function routeTime(root: string): Promise<number> {
	const base = join(root, "packages", "pi-switchboard");
	const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(base, "src", file)).href)) as T;
	const modules: RuleModules = {
		questions: await load("classifier/questions.ts"),
		builtin: await load("rules/builtin.ts"),
		evaluate: await load("rules/evaluate.ts"),
	};
	const cases = (
		JSON.parse(readFileSync(join(base, "test", "fixtures", "h2o-calibration.json"), "utf8")) as {
			cases: Array<{ answers: Record<string, Record<string, number | string>> }>;
		}
	).cases;
	const answers = cases.map(({ answers: a }) => ({
		work: { type: "choice", choice: a.work?.choice, probabilities: {}, confidence: a.work?.confidence },
		depth: { type: "score", score: a.depth?.score, confidence: a.depth?.confidence },
		risky: { type: "bool", probability: a.risky?.probability },
	}));
	const profile = {
		ruleset: modules.builtin.BUILTIN_RULESET,
		tiers: [
			{ name: "light", rank: 0 },
			{ name: "standard", rank: 1 },
			{ name: "deep", rank: 2 },
		],
		fallbackTier: "standard",
	};
	const started = performance.now();
	for (let repeat = 0; repeat < REPEATS_PER_ROUTE_SAMPLE; repeat += 1)
		for (const answer of answers) modules.evaluate.evaluateRules(profile, modules.questions.BUILTIN_QUESTIONS, answer, {}, 0.7);
	return performance.now() - started;
}

const BENCHES: Bench[] = [
	{
		package: "pi",
		name: "baseline",
		method: "Real pi in RPC mode on an empty agent directory with no extension loaded; wall time from spawn to the get_commands answer. What each package's load time is read against.",
		thresholds: { alpha: 0.01, minSlowdown: 0.25, minAbsolute: 25 },
		run: (root: string) => loadTime(root, undefined),
	},
	...listPackages()
		.filter(({ manifest }) => manifest.private !== true)
		.map(({ dir }) => ({
			package: dir,
			name: "load",
			method: "Real pi in RPC mode on an empty agent directory with the extension loaded; wall time from spawn to the get_commands answer.",
			thresholds: { alpha: 0.01, minSlowdown: 0.25, minAbsolute: 25 },
			run: (root: string) => loadTime(root, dir),
		})),
	{
		package: "pi-switchboard",
		name: "route",
		method: `Rule evaluation of the 24 calibration requests, ${REPEATS_PER_ROUTE_SAMPLE} times over, in one process.`,
		thresholds: { alpha: 0.01, minSlowdown: 0.25, minAbsolute: 0.3 },
		perSample: CALIBRATION_CASES * REPEATS_PER_ROUTE_SAMPLE,
		run: routeTime,
	},
];

interface Options {
	head: string;
	base: string | undefined;
	samples: number;
	only: string | undefined;
	write: string | undefined;
	json: string | undefined;
	fail: boolean;
}

/** How each option that takes a value sets itself. */
const VALUE_OPTIONS: Record<string, (options: Options, value: string) => void> = {
	"--head": (options, value) => {
		options.head = resolve(value);
	},
	"--base": (options, value) => {
		options.base = resolve(value);
	},
	"--samples": (options, value) => {
		options.samples = Number(value);
	},
	"--only": (options, value) => {
		options.only = value;
	},
	"--write": (options, value) => {
		options.write = resolve(value);
	},
	"--json": (options, value) => {
		options.json = resolve(value);
	},
};

function parseArguments(argv: string[]): Options {
	const options: Options = { head: ROOT, base: undefined, samples: 30, only: undefined, write: undefined, json: undefined, fail: false };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index] ?? "";
		if (flag === "--fail") {
			options.fail = true;
			continue;
		}
		const set = VALUE_OPTIONS[flag];
		const value = argv[index + 1];
		if (!set || value === undefined) throw new Error(`unknown or incomplete option ${flag}`);
		set(options, value);
		index += 1;
	}
	if (!Number.isInteger(options.samples) || options.samples < 8)
		throw new Error("--samples must be a whole number of at least 8: fewer cannot show a difference");
	return options;
}

interface Timings {
	head: number[];
	base: number[];
}

/** `samples` timings of each tree, alternating which goes first so neither always gets the quieter moment, after a few discarded warm-up runs. */
async function measure(bench: Bench, options: Options): Promise<Timings> {
	const timings: Timings = { head: [], base: [] };
	for (let warm = 0; warm < WARMUP; warm += 1) {
		await bench.run(options.head);
		if (options.base) await bench.run(options.base);
	}
	for (let sample = 0; sample < options.samples; sample += 1) {
		const order = options.base && sample % 2 === 1 ? (["base", "head"] as const) : (["head", "base"] as const);
		for (const which of order) {
			if (which === "base" && !options.base) continue;
			timings[which].push(await bench.run(which === "head" ? options.head : (options.base as string)));
		}
	}
	return timings;
}

const git = (dir: string, ...args: string[]): string => {
	try {
		return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "unknown";
	}
};

const options = parseArguments(process.argv.slice(2));
const piVersion = (JSON.parse(readFileSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")) as { version: string })
	.version;
const environment = { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length, pi: piVersion };
const commit = git(options.head, "rev-parse", "--short", "HEAD");
const date = new Date().toISOString().slice(0, 10);
const report: unknown[] = [];
let confirmed = 0;

for (const bench of BENCHES.filter(
	(candidate) => !options.only || `${candidate.package}/${candidate.name}` === options.only || candidate.name === options.only,
)) {
	const label = `${bench.package}/${bench.name}`;
	// A package the base does not have yet (a pull request that adds one) is measured on the head only; there is nothing to compare it with.
	const hasBase = options.base !== undefined && existsSync(join(options.base, "packages", bench.package, "src", "index.ts"));
	const measuring: Options = { ...options, base: hasBase ? options.base : undefined };
	let timings = await measure(bench, measuring);
	let comparison: Comparison | undefined = measuring.base ? compareTimings(timings.base, timings.head, bench.thresholds) : undefined;
	let rerun = false;
	if (comparison?.regression) {
		rerun = true;
		const again = await measure(bench, measuring);
		const second = compareTimings(again.base, again.head, bench.thresholds);
		if (second.regression) {
			timings = { head: [...timings.head, ...again.head], base: [...timings.base, ...again.base] };
			comparison = compareTimings(timings.base, timings.head, bench.thresholds);
			confirmed += 1;
		} else {
			comparison = { ...second, regression: false };
			timings = again;
		}
	}
	const headMedian = median(timings.head);
	const summary = comparison
		? `base ${comparison.baseMedian.toFixed(1)} ms, head ${comparison.headMedian.toFixed(1)} ms, x${comparison.ratio.toFixed(2)}, p ${comparison.p < 1e-12 ? "<1e-12" : comparison.p.toExponential(1)}${comparison.regression ? "  REGRESSION" : rerun ? "  (flagged once, not confirmed)" : ""}`
		: `head median ${headMedian.toFixed(1)} ms over ${timings.head.length} samples`;
	console.log(`${label.padEnd(30)} ${summary}`);
	const record = {
		schema: 1,
		package: bench.package,
		name: bench.name,
		unit: "ms",
		method: bench.method,
		samples: timings.head,
		...(bench.perSample === undefined ? {} : { perSample: bench.perSample }),
		environment,
		commit,
		date,
		...(comparison ? { base: { samples: timings.base, commit: git(measuring.base as string, "rev-parse", "--short", "HEAD") }, comparison } : {}),
	};
	report.push(record);
	if (options.write) {
		const folder = join(options.write, bench.package, bench.name);
		mkdirSync(folder, { recursive: true });
		const { schema, package: pkg, name, unit, method, samples, perSample, environment: env, commit: sha, date: day } = record;
		writeFileSync(
			join(folder, "results.json"),
			`${JSON.stringify({ schema, package: pkg, name, unit, method, samples, ...(perSample === undefined ? {} : { perSample }), environment: env, commit: sha, date: day }, null, "\t")}\n`,
		);
	}
}

if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, "\t")}\n`);
if (confirmed > 0) console.log(`bench: ${confirmed} regression(s) confirmed by a second measurement`);
process.exitCode = options.fail && confirmed > 0 ? 1 : 0;
