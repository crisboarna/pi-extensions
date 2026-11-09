// The benchmark pages and charts, generated from the committed results (benchmarks/<package>/<name>/results.json), never written by hand: every number on a page
// is computed here from the samples, so a page cannot drift from its data, and a test regenerates them all and compares. Pure: no file access.
import { type ChartRow, renderChart } from "../../tools/charts/render.ts";
import { median, quantile } from "./stats.ts";

export interface BenchResult {
	schema: number;
	package: string;
	name: string;
	unit: string;
	method: string;
	samples: number[];
	/** How many decisions one sample covers, when a sample is a batch of them. */
	perSample?: number;
	environment: { node: string; platform: string; arch: string; cpus: number; pi: string };
	commit: string;
	date: string;
}

const BASELINE = "#8a9bb0";
const MEASURED = "#c9a34e";

const ms = (value: number): string => `${value.toFixed(1)} ms`;
const range = (samples: number[]): string => `${quantile(samples, 0.1).toFixed(1)} to ${quantile(samples, 0.9).toFixed(1)} ms`;

const find = (results: readonly BenchResult[], pkg: string, name: string): BenchResult | undefined =>
	results.find((result) => result.package === pkg && result.name === name);

function loadSection(pkg: string, load: BenchResult, baseline: BenchResult): { chart: string; text: string } {
	const rows: ChartRow[] = [
		{ label: "pi alone", detail: `median ${ms(median(baseline.samples))}`, samples: baseline.samples, color: BASELINE },
		{ label: `pi with ${pkg}`, detail: `median ${ms(median(load.samples))}`, samples: load.samples, color: MEASURED },
	];
	const chart = renderChart({
		title: "Time for pi to answer get_commands",
		subtitle: `${load.samples.length} runs each. The tick is the median; the band is the 10th to 90th percentile.`,
		unit: "ms, from starting pi",
		rows,
	});
	const added = median(load.samples) - median(baseline.samples);
	const spread = quantile(load.samples, 0.9) - quantile(load.samples, 0.1);
	const verdict =
		added > spread / 2
			? `Loading ${pkg} adds about ${ms(added)} to pi's start (the difference of the two medians).`
			: `Loading ${pkg} adds ${ms(Math.max(0, added))} at the median, which is within the spread of the runs: too small to tell apart from noise.`;
	const text = [
		"## Start",
		"",
		`![Time for pi to answer get_commands, alone and with ${pkg}: the medians are ${ms(median(baseline.samples))} and ${ms(median(load.samples))}](benchmarks/load.svg)`,
		"",
		"| | Median | 10th to 90th percentile | Runs |",
		"|---|---|---|---|",
		`| pi alone | ${ms(median(baseline.samples))} | ${range(baseline.samples)} | ${baseline.samples.length} |`,
		`| pi with ${pkg} | ${ms(median(load.samples))} | ${range(load.samples)} | ${load.samples.length} |`,
		"",
		verdict,
	].join("\n");
	return { chart, text };
}

function routeSection(route: BenchResult): { chart: string; text: string } {
	const chart = renderChart({
		title: `Time for ${route.package} to evaluate its rules`,
		subtitle: `${route.samples.length} runs. The tick is the median; the band is the 10th to 90th percentile.`,
		unit: "ms per run",
		rows: [{ label: "rule evaluation", detail: `median ${ms(median(route.samples))}`, samples: route.samples, color: MEASURED }],
	});
	const perDecision = route.perSample ? `${((median(route.samples) / route.perSample) * 1000).toFixed(2)} µs` : undefined;
	const text = [
		"## Routing decision",
		"",
		`![Time for ${route.package} to evaluate its rules over ${route.perSample ?? "its"} decisions: the median is ${ms(median(route.samples))}](benchmarks/route.svg)`,
		"",
		"| | Median | 10th to 90th percentile | Runs |",
		"|---|---|---|---|",
		`| ${route.perSample ?? "A batch of"} rule evaluations | ${ms(median(route.samples))} | ${range(route.samples)} | ${route.samples.length} |`,
		"",
		perDecision
			? `That is about ${perDecision} for one decision (the median divided by ${route.perSample}). It is the rule step after the classifier has answered; the classifier's own time depends on the model server and is not measured here.`
			: "It is the rule step after the classifier has answered; the classifier's own time depends on the model server and is not measured here.",
	].join("\n");
	return { chart, text };
}

function page(pkg: string, sections: string[], used: BenchResult[]): string {
	const first = used[0] as BenchResult;
	const environment = first.environment;
	return [
		"# Benchmarks",
		"",
		`What ${pkg} costs in time, measured and not estimated. Every number and chart on this page is generated from the recorded runs in \`benchmarks/\` by \`npm run charts\`.`,
		"",
		...sections.flatMap((section) => [section, ""]),
		"## How it was measured",
		"",
		...used.map((result) => `- **${result.name}:** ${result.method}`),
		`- **Machine:** Node ${environment.node.replace(/^v/, "")} on ${environment.platform} ${environment.arch} with ${environment.cpus} CPUs, pi ${environment.pi}.`,
		`- **Code:** commit \`${first.commit}\`, measured ${first.date}.`,
		"- **Again:** `node scripts/bench.ts --samples 30 --write benchmarks`, then `npm run format` and `npm run charts`.",
		"",
		"## What this does not tell you",
		"",
		"- It is one machine. Another machine is slower or faster; the latency job in CI compares a change with its base on one machine and publishes no absolute numbers.",
		"- The start time runs from starting pi to its first answer over RPC, not to the first reply from a model.",
		"- A difference of a few milliseconds is inside the spread of the runs.",
		"",
	].join("\n");
}

/** Every generated file, by its path from the repository root: for each package with a start result, its page and charts. */
export function benchmarkFiles(results: readonly BenchResult[]): Record<string, string> {
	const files: Record<string, string> = {};
	const baseline = find(results, "pi", "baseline");
	if (!baseline) return files;
	for (const pkg of [...new Set(results.map((result) => result.package))].filter((name) => name !== "pi").sort()) {
		const load = find(results, pkg, "load");
		if (!load) continue;
		const sections: string[] = [];
		const used: BenchResult[] = [baseline, load];
		const start = loadSection(pkg, load, baseline);
		files[`packages/${pkg}/docs/benchmarks/load.svg`] = start.chart;
		sections.push(start.text);
		const route = find(results, pkg, "route");
		if (route) {
			const routing = routeSection(route);
			files[`packages/${pkg}/docs/benchmarks/route.svg`] = routing.chart;
			sections.push(routing.text);
			used.push(route);
		}
		files[`packages/${pkg}/docs/benchmarks.md`] = page(pkg, sections, used);
	}
	return files;
}
