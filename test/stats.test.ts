// The latency gate decides from these functions, so they are checked against what can be computed independently: the exact distribution of the rank test
// (every possible split of the ranks, enumerated) for the p value, tabulated normal values for the cdf, and invented timings whose answer is known.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareTimings, mannWhitneyU, median, normalCdf } from "../scripts/lib/stats.ts";

/** The exact two-sided p of the rank test for samples with no ties: the share of all ways to choose the first sample's ranks that are at least as far from the mean. */
function exactP(a: number[], b: number[]): number {
	const n1 = a.length;
	const n = a.length + b.length;
	const sorted = [...a, ...b].sort((x, y) => x - y);
	const rankOf = (value: number) => sorted.indexOf(value) + 1;
	const observed = a.reduce((sum, value) => sum + rankOf(value), 0) - (n1 * (n1 + 1)) / 2;
	const mean = (n1 * (n - n1)) / 2;
	let total = 0;
	let atLeastAsFar = 0;
	const walk = (next: number, chosen: number, rankSum: number) => {
		if (chosen === n1) {
			total += 1;
			const u = rankSum - (n1 * (n1 + 1)) / 2;
			if (Math.abs(u - mean) >= Math.abs(observed - mean) - 1e-9) atLeastAsFar += 1;
			return;
		}
		for (let rank = next; rank <= n - (n1 - chosen) + 1; rank += 1) walk(rank + 1, chosen + 1, rankSum + rank);
	};
	walk(1, 0, 0);
	return atLeastAsFar / total;
}

/** A small deterministic generator, so no test depends on chance. */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const around = (center: number, spread: number, count: number, seed: number) => {
	const random = seeded(seed);
	return Array.from({ length: count }, () => center + (random() - 0.5) * spread);
};

describe("median", () => {
	test("takes the middle value, the mean of the two middle values, and NaN for nothing", () => {
		assert.equal(median([3, 1, 2]), 2);
		assert.equal(median([4, 1, 3, 2]), 2.5);
		assert.equal(median([7]), 7);
		assert.ok(Number.isNaN(median([])));
	});

	test("is not moved by one extreme value, which is why the gate uses it", () => {
		assert.equal(median([10, 11, 10, 12, 11, 10_000]), 11);
	});
});

describe("normalCdf", () => {
	test("matches the tabulated standard normal", () => {
		for (const [z, expected] of [
			[0, 0.5],
			[1, 0.8413447],
			[1.96, 0.9750021],
			[-1.96, 0.0249979],
			[2.5758293, 0.995],
			[-3, 0.0013499],
		] as const) {
			assert.ok(Math.abs(normalCdf(z) - expected) < 1e-6, `Φ(${z}) = ${normalCdf(z)}, expected ${expected}`);
		}
	});
});

describe("mannWhitneyU", () => {
	test("counts the pairs in which the first sample is above the second, and the two directions add up to every pair", () => {
		assert.equal(mannWhitneyU([1, 2, 3], [4, 5, 6]).u, 0);
		assert.equal(mannWhitneyU([4, 5, 6], [1, 2, 3]).u, 9);
		const a = [3, 9, 4, 7, 1];
		const b = [8, 2, 6, 5];
		assert.equal(mannWhitneyU(a, b).u + mannWhitneyU(b, a).u, a.length * b.length);
	});

	test("gives a p value close to the exact one wherever the exact one can be enumerated", () => {
		const cases: Array<[number[], number[]]> = [
			[
				[1, 2, 3, 4, 5, 6, 7, 8],
				[9, 10, 11, 12, 13, 14, 15, 16],
			],
			[
				[1, 3, 5, 7, 9, 11, 13, 15],
				[2, 4, 6, 8, 10, 12, 14, 16],
			],
			[
				[1, 2, 3, 4, 5, 6, 7, 12],
				[8, 9, 10, 11, 13, 14, 15, 16],
			],
			[
				[2, 4, 6, 8, 11, 12, 15, 16],
				[1, 3, 5, 7, 9, 10, 13, 14],
			],
			[
				[10, 11, 12, 13, 14, 15, 16, 17, 18],
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 19],
			],
		];
		for (const [a, b] of cases) {
			const approximate = mannWhitneyU(a, b).p;
			const exact = exactP(a, b);
			assert.ok(Math.abs(approximate - exact) < 0.02, `exact ${exact}, approximate ${approximate} for ${a} against ${b}`);
		}
	});

	test("is small for samples that do not overlap and large for samples that interleave", () => {
		assert.ok(mannWhitneyU(around(150, 20, 30, 1), around(100, 20, 30, 2)).p < 1e-6);
		assert.ok(mannWhitneyU([1, 3, 5, 7, 9, 11], [2, 4, 6, 8, 10, 12]).p > 0.6, "U is 15 of a mean 18, a z of about -0.4");
	});

	test("does not care which sample is first: the p value is two-sided", () => {
		const a = around(120, 30, 20, 3);
		const b = around(100, 30, 20, 4);
		assert.equal(mannWhitneyU(a, b).p, mannWhitneyU(b, a).p);
	});

	test("says there is no difference when every value is the same, and does not divide by zero", () => {
		const result = mannWhitneyU([5, 5, 5, 5], [5, 5, 5, 5]);
		assert.equal(result.p, 1);
		assert.equal(result.z, 0);
	});

	test("handles ties, ranking them together", () => {
		const result = mannWhitneyU([1, 2, 2, 3, 3, 3], [3, 4, 4, 5, 5, 6]);
		assert.ok(result.p > 0 && result.p < 0.1, `p ${result.p}`);
		assert.equal(result.u + mannWhitneyU([3, 4, 4, 5, 5, 6], [1, 2, 2, 3, 3, 3]).u, 36);
	});

	test("an empty sample gives NaN, never a verdict", () => {
		assert.ok(Number.isNaN(mannWhitneyU([], [1, 2]).p));
		assert.ok(Number.isNaN(mannWhitneyU([1, 2], []).p));
	});
});

describe("compareTimings", () => {
	const thresholds = { alpha: 0.01, minSlowdown: 0.25, minAbsolute: 5 };

	test("flags a change that is clearly, substantially and materially slower", () => {
		const verdict = compareTimings(around(100, 20, 30, 10), around(160, 20, 30, 11), thresholds);
		assert.equal(verdict.regression, true);
		assert.ok(verdict.ratio > 1.5 && verdict.p < 1e-6, JSON.stringify(verdict));
	});

	test("does not flag two runs of the same code, however the noise falls", () => {
		for (let seed = 1; seed <= 20; seed += 1) {
			const verdict = compareTimings(around(100, 30, 30, seed), around(100, 30, 30, seed + 100), thresholds);
			assert.equal(verdict.regression, false, `seed ${seed}: ${JSON.stringify(verdict)}`);
		}
	});

	test("does not flag a significant slowdown that is under the ratio the gate allows", () => {
		const verdict = compareTimings(around(100, 6, 30, 20), around(115, 6, 30, 21), thresholds);
		assert.ok(verdict.p < 0.01, "it is significant");
		assert.equal(verdict.regression, false);
	});

	test("does not flag a large ratio of a very small time", () => {
		const verdict = compareTimings(around(1, 0.1, 30, 30), around(2, 0.1, 30, 31), thresholds);
		assert.ok(verdict.ratio > 1.8 && verdict.p < 0.01);
		assert.equal(verdict.regression, false, "one more millisecond is not worth a failure");
	});

	test("never flags a change that got faster", () => {
		const verdict = compareTimings(around(160, 20, 30, 40), around(100, 20, 30, 41), thresholds);
		assert.equal(verdict.regression, false);
		assert.ok(verdict.ratio < 1);
	});

	test("one extreme sample does not make a regression", () => {
		const head = around(100, 20, 30, 51);
		head[7] = 5000;
		assert.equal(compareTimings(around(100, 20, 30, 50), head, thresholds).regression, false);
	});

	test("says nothing when there is nothing to compare", () => {
		const verdict = compareTimings([], [1, 2, 3], thresholds);
		assert.equal(verdict.regression, false);
		assert.ok(Number.isNaN(verdict.p));
	});
});
