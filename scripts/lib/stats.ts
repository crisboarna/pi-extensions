// Statistics for the latency gate: whether a change made something slower, or whether two runs only differ by noise. Pure functions over arrays of numbers.
// A median and a rank test are used, not a mean and a t-test, because timings are skewed and a single slow sample (a busy runner) must not decide a result.

export function median(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** The value below which a share `q` (0 to 1) of the values lie, by linear interpolation between the two nearest ranks; NaN for no values. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const position = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
	const below = Math.floor(position);
	const above = Math.ceil(position);
	return (sorted[below] as number) + ((sorted[above] as number) - (sorted[below] as number)) * (position - below);
}

/** The complementary error function, to a relative error under 1.2e-7 everywhere (Numerical Recipes, erfcc). */
function erfc(x: number): number {
	const z = Math.abs(x);
	const t = 1 / (1 + 0.5 * z);
	const poly =
		-z * z -
		1.26551223 +
		t *
			(1.00002368 +
				t *
					(0.37409196 +
						t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
	const result = t * Math.exp(poly);
	return x >= 0 ? result : 2 - result;
}

/** The standard normal distribution's cumulative probability. */
export const normalCdf = (z: number): number => 0.5 * erfc(-z / Math.SQRT2);

export interface RankTest {
	/** The U statistic of the first sample: how many pairs (a, b) have a above b, ties counting half. */
	u: number;
	/** The standardised statistic, with the continuity correction and the correction for ties. */
	z: number;
	/** The two-sided probability of a split at least this uneven if both samples came from one distribution (normal approximation). */
	p: number;
}

/**
 * The Mann-Whitney U test of two independent samples: do the values of one tend to lie above the other's? It works on ranks, so it needs no assumption
 * about the shape of the timings. The p value is the normal approximation with a continuity correction and a correction for ties, which is close to
 * exact from about eight values in each sample and is what the gate uses with thirty or more.
 */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): RankTest {
	const n1 = a.length;
	const n2 = b.length;
	if (n1 === 0 || n2 === 0) return { u: Number.NaN, z: Number.NaN, p: Number.NaN };
	const all = [...a.map((value) => ({ value, first: true })), ...b.map((value) => ({ value, first: false }))].sort((x, y) => x.value - y.value);
	const n = all.length;
	let rankSumFirst = 0;
	let tieTerm = 0;
	for (let start = 0; start < n; ) {
		let end = start;
		while (end + 1 < n && (all[end + 1] as { value: number }).value === (all[start] as { value: number }).value) end += 1;
		const rank = (start + end) / 2 + 1;
		const size = end - start + 1;
		tieTerm += size ** 3 - size;
		for (let index = start; index <= end; index += 1) if ((all[index] as { first: boolean }).first) rankSumFirst += rank;
		start = end + 1;
	}
	const u = rankSumFirst - (n1 * (n1 + 1)) / 2;
	const mean = (n1 * n2) / 2;
	const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
	if (variance <= 0) return { u, z: 0, p: 1 };
	const gap = u - mean;
	const z = (gap - Math.sign(gap) * Math.min(0.5, Math.abs(gap))) / Math.sqrt(variance);
	return { u, z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

export interface Thresholds {
	/** The p value below which a difference is not put down to noise. */
	alpha: number;
	/** The slowdown of the median, as a fraction: 0.25 is a quarter slower. */
	minSlowdown: number;
	/** The slowdown of the median, in the samples' own unit, below which a difference is too small to matter whatever its ratio. */
	minAbsolute: number;
}

export interface Comparison {
	baseMedian: number;
	headMedian: number;
	/** head / base; above 1 is slower. */
	ratio: number;
	p: number;
	/** True when all three tests say slower: unlikely to be noise, a large share of the time, and a large amount of time. */
	regression: boolean;
}

/** Compares timings of the base and the head of a change; `regression` needs the difference to be significant, relatively large and absolutely large. */
export function compareTimings(base: readonly number[], head: readonly number[], thresholds: Thresholds): Comparison {
	const baseMedian = median(base);
	const headMedian = median(head);
	const { p } = mannWhitneyU(head, base);
	const ratio = baseMedian > 0 ? headMedian / baseMedian : Number.NaN;
	const regression = p < thresholds.alpha && ratio > 1 + thresholds.minSlowdown && headMedian - baseMedian > thresholds.minAbsolute;
	return { baseMedian, headMedian, ratio, p, regression };
}
