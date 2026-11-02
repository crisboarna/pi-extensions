// The badges are numbers a reader trusts, so each rule that could flatter the repository has a test: rounding goes down, an empty report is 0%
// and never 100%, one weak package sets the root number, and a package that did not measure leaves no root number at all.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	allBadges,
	coverageBadge,
	coverageColor,
	dependenciesBadge,
	lowestCoverageBadge,
	lowestPercent,
	nodeBadge,
	parseLcov,
	percent,
	piBadge,
} from "../scripts/lib/badges.ts";

const report = (lf: number, lh: number, brf: number, brh: number, fnf: number, fnh: number) =>
	`TN:\nSF:a.ts\nFNF:${fnf}\nFNH:${fnh}\nBRF:${brf}\nBRH:${brh}\nLF:${lf}\nLH:${lh}\nend_of_record\n`;

describe("parseLcov", () => {
	test("adds the totals of every file in the report", () => {
		const text = `${report(10, 9, 4, 3, 2, 2)}${report(30, 21, 6, 6, 3, 1)}`;
		assert.deepEqual(parseLcov(text), { lines: { found: 40, hit: 30 }, branches: { found: 10, hit: 9 }, functions: { found: 5, hit: 3 } });
	});

	test("ignores lines that are not totals, and totals that are not whole counts", () => {
		const text = "SF:a.ts\nDA:1,1\nBRDA:1,0,0,1\nLF:abc\nLH:-3\nLF:2.5\nLF:4\nLH:4\n";
		assert.deepEqual(parseLcov(text).lines, { found: 4, hit: 4 });
	});

	test("an empty report gives zeros", () => {
		assert.deepEqual(parseLcov(""), { lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } });
	});
});

describe("percent", () => {
	test("rounds down, so 89.9% is never shown as 90%", () => {
		assert.equal(percent({ found: 1000, hit: 899 }), 89);
		assert.equal(percent({ found: 3, hit: 2 }), 66);
		assert.equal(percent({ found: 10, hit: 10 }), 100);
	});

	test("nothing found is 0%, not 100%, and more hits than found is capped", () => {
		assert.equal(percent({ found: 0, hit: 0 }), 0);
		assert.equal(percent({ found: 5, hit: 9 }), 100);
	});
});

describe("coverage badges", () => {
	test("the badge shows the lowest of lines, branches and functions", () => {
		const coverage = parseLcov(report(100, 100, 100, 91, 100, 96));
		assert.equal(lowestPercent(coverage), 91);
		assert.deepEqual(coverageBadge(coverage), { schemaVersion: 1, label: "coverage", message: "91%", color: "brightgreen" });
	});

	test("the colour is green only from the 90% the gate demands", () => {
		assert.deepEqual([100, 90, 89, 80, 79, 60, 59, 0].map(coverageColor), [
			"brightgreen",
			"brightgreen",
			"yellow",
			"yellow",
			"orange",
			"orange",
			"red",
			"red",
		]);
	});

	test("the root badge is the lowest package, so one weak package cannot hide", () => {
		const strong = parseLcov(report(100, 100, 100, 100, 100, 100));
		const weak = parseLcov(report(100, 85, 100, 100, 100, 100));
		assert.equal(lowestCoverageBadge([strong, weak, strong]).message, "85%");
		assert.equal(lowestCoverageBadge([strong, weak]).color, "yellow");
		assert.deepEqual(lowestCoverageBadge([]), { schemaVersion: 1, label: "coverage", message: "unknown", color: "lightgrey" });
	});
});

describe("declared facts", () => {
	test("node and pi show the declared range as written, and unknown when there is none", () => {
		assert.equal(nodeBadge(">=22.19").message, ">=22.19");
		assert.equal(piBadge(">=1.4.0 <2").message, ">=1.4.0 <2");
		assert.equal(nodeBadge(undefined).message, "unknown");
		assert.equal(piBadge("").color, "lightgrey");
	});

	test("dependencies are counted, and none is green", () => {
		assert.deepEqual(dependenciesBadge(undefined), { schemaVersion: 1, label: "runtime dependencies", message: "0", color: "brightgreen" });
		assert.equal(dependenciesBadge({ a: "1.0.0" }).color, "green");
		assert.equal(dependenciesBadge({ a: "1", b: "1", c: "1" }).message, "3");
		assert.equal(dependenciesBadge({ a: "1", b: "1", c: "1", d: "1" }).color, "yellow");
	});
});

describe("allBadges", () => {
	const facts = (dir: string, lcov: string | undefined) => ({ dir, nodeRange: ">=22", piRange: ">=1.4.0 <2", dependencies: undefined, lcov });

	test("writes four documents per package and a root coverage document when every package measured", () => {
		const out = allBadges([facts("one", report(10, 10, 10, 10, 10, 10)), facts("two", report(10, 9, 10, 10, 10, 10))]);
		assert.deepEqual(Object.keys(out).sort(), [
			"coverage.json",
			"one/coverage.json",
			"one/dependencies.json",
			"one/node.json",
			"one/pi.json",
			"two/coverage.json",
			"two/dependencies.json",
			"two/node.json",
			"two/pi.json",
		]);
		assert.equal(out["coverage.json"]?.message, "90%");
	});

	test("a package with no report has no coverage badge, and then there is no root number", () => {
		const out = allBadges([facts("one", report(10, 10, 10, 10, 10, 10)), facts("two", undefined)]);
		assert.ok("one/coverage.json" in out);
		assert.ok(!("two/coverage.json" in out));
		assert.ok(!("coverage.json" in out), "a root number from some packages would hide the one that did not report");
	});
});
