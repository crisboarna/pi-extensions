// The charts and benchmark pages are generated from recorded runs, so they are only worth anything if they are exactly what the data gives: the chart is
// deterministic, the sentence on a page says what the numbers say (an effect, or noise), and every committed file is what the committed data produces.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { staleFiles } from "../scripts/charts.ts";
import { type BenchResult, benchmarkFiles } from "../scripts/lib/benchmark-pages.ts";
import { renderChart, tickStep } from "../tools/charts/render.ts";

const result = (pkg: string, name: string, samples: number[], extra: Partial<BenchResult> = {}): BenchResult => ({
	schema: 1,
	package: pkg,
	name,
	unit: "ms",
	method: `how ${name} was measured`,
	samples,
	environment: { node: "v24.0.0", platform: "darwin", arch: "arm64", cpus: 8, pi: "1.4.0" },
	commit: "abc1234",
	date: "2026-11-03",
	...extra,
});

const around = (center: number, spread: number, count = 30) => Array.from({ length: count }, (_, index) => center + ((index % 7) - 3) * spread);

describe("tickStep", () => {
	test("is the smallest round step that gives no more than seven ticks", () => {
		assert.equal(tickStep(7), 1);
		assert.equal(tickStep(8), 2);
		assert.equal(tickStep(150), 25);
		assert.equal(tickStep(2.4), 1);
		assert.equal(tickStep(6000), 1000);
		assert.equal(tickStep(100000), 2000);
	});
});

describe("renderChart", () => {
	const spec = {
		title: "Time & <more>",
		subtitle: "30 runs",
		unit: "ms",
		rows: [
			{ label: "pi alone", detail: "median 100.0 ms", samples: around(100, 1), color: "#8a9bb0" },
			{ label: "pi with x", detail: "median 120.0 ms", samples: around(120, 1), color: "#c9a34e" },
		],
	};

	test("gives the same bytes for the same data, with no randomness and no date", () => {
		assert.equal(renderChart(spec), renderChart(spec));
		assert.doesNotMatch(renderChart(spec), /20\d\d-\d\d-\d\d/);
	});

	test("draws one dot per sample, one median tick and one band per row, on one card", () => {
		const svg = renderChart(spec);
		assert.equal(svg.match(/<circle /g)?.length, 60);
		assert.equal(svg.match(/stroke="#f1e6cf" stroke-width="2.5"/g)?.length, 2);
		assert.equal(svg.match(/fill-opacity="0.18"/g)?.length, 2);
		assert.equal(svg.match(/<svg /g)?.length, 1);
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 760 /);
	});

	test("escapes the text it is given, and names the chart and its rows for a screen reader", () => {
		const svg = renderChart(spec);
		assert.ok(svg.includes("Time &amp; &lt;more&gt;"));
		assert.ok(!svg.includes("<more>"));
		assert.match(svg, /<title id="chart-title">Time &amp; &lt;more&gt;<\/title>/);
		assert.match(svg, /<desc id="chart-desc">30 runs pi alone: median 100\.0 ms\. pi with x: median 120\.0 ms\.<\/desc>/);
	});

	test("starts the axis at zero, so a difference looks as large as it is, and puts the larger median to the right", () => {
		const svg = renderChart(spec);
		assert.ok(svg.includes(">0</text>"));
		const ticks = [...svg.matchAll(/<line x1="([\d.]+)" y1="\d+(?:\.\d+)?" x2="\1" y2="\d+(?:\.\d+)?" stroke="#f1e6cf"/g)].map((match) => Number(match[1]));
		assert.equal(ticks.length, 2);
		assert.ok((ticks[0] as number) < (ticks[1] as number));
	});

	test("grows with the number of rows", () => {
		const one = renderChart({ ...spec, rows: [spec.rows[0] as (typeof spec.rows)[number]] });
		const height = (svg: string) => Number(/viewBox="0 0 760 (\d+)"/.exec(svg)?.[1]);
		assert.ok(height(renderChart(spec)) > height(one));
	});
});

describe("benchmarkFiles", () => {
	const baseline = result("pi", "baseline", around(100, 1));

	test("writes a page and a chart for a package, and a routing chart only when it has a routing result", () => {
		const files = benchmarkFiles([
			baseline,
			result("pi-a", "load", around(125, 1)),
			result("pi-b", "load", around(130, 1)),
			result("pi-b", "route", around(2.5, 0.01), { perSample: 4800 }),
		]);
		assert.deepEqual(Object.keys(files).sort(), [
			"packages/pi-a/docs/benchmarks.md",
			"packages/pi-a/docs/benchmarks/load.svg",
			"packages/pi-b/docs/benchmarks.md",
			"packages/pi-b/docs/benchmarks/load.svg",
			"packages/pi-b/docs/benchmarks/route.svg",
		]);
	});

	test("says what an extension adds when that is larger than the spread of the runs", () => {
		const page = benchmarkFiles([baseline, result("pi-a", "load", around(125, 1))])["packages/pi-a/docs/benchmarks.md"] ?? "";
		assert.match(page, /Loading pi-a adds about 25\.0 ms to pi's start/);
		assert.match(page, /\| pi alone \| 100\.0 ms \| 97\.0 to 103\.0 ms \| 30 \|/);
		assert.match(page, /\(benchmarks\/load\.svg\)/);
	});

	test("says it is noise when the difference is inside the spread of the runs, and never a negative cost", () => {
		const slightlyFaster = benchmarkFiles([baseline, result("pi-a", "load", around(99, 1))])["packages/pi-a/docs/benchmarks.md"] ?? "";
		assert.match(slightlyFaster, /adds 0\.0 ms at the median, which is within the spread of the runs/);
		assert.doesNotMatch(slightlyFaster, /adds about -/);
	});

	test("calls a small slowdown noise when it is under half the spread of the runs, and an effect when it is over", () => {
		const small = benchmarkFiles([baseline, result("pi-a", "load", around(101, 1))])["packages/pi-a/docs/benchmarks.md"] ?? "";
		assert.match(small, /adds 1\.0 ms at the median, which is within the spread of the runs/);
		const large = benchmarkFiles([baseline, result("pi-a", "load", around(104, 1))])["packages/pi-a/docs/benchmarks.md"] ?? "";
		assert.match(large, /adds about 4\.0 ms to pi's start/);
	});

	test("divides the routing time by the decisions in a sample", () => {
		const page =
			benchmarkFiles([baseline, result("pi-b", "load", around(130, 1)), result("pi-b", "route", around(2.4, 0), { perSample: 4800 })])[
				"packages/pi-b/docs/benchmarks.md"
			] ?? "";
		assert.match(page, /about 0\.50 µs for one decision \(the median divided by 4800\)/);
	});

	test("states the machine, the commit and the date from the data, and what the page does not show", () => {
		const page = benchmarkFiles([baseline, result("pi-a", "load", around(125, 1))])["packages/pi-a/docs/benchmarks.md"] ?? "";
		assert.match(page, /Node 24\.0\.0 on darwin arm64 with 8 CPUs, pi 1\.4\.0/);
		assert.match(page, /commit `abc1234`, measured 2026-11-03/);
		assert.match(page, /## What this does not tell you/);
	});

	test("writes nothing without a baseline, and skips a package with no start result", () => {
		assert.deepEqual(benchmarkFiles([result("pi-a", "load", around(125, 1))]), {});
		assert.deepEqual(benchmarkFiles([baseline, result("pi-a", "route", around(2, 0))]), {});
	});
});

describe("the committed pages", () => {
	test("are exactly what the committed data gives, so a page cannot drift from its numbers", () => {
		assert.deepEqual(staleFiles(), []);
	});
});
