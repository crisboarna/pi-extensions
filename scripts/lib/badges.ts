// The numbers behind the README badges. Each is computed from what CI just measured (an lcov file, a manifest), written as a shields.io endpoint
// document and served from the family site, so a badge can never say more than the verified main branch proved. Pure: no file or network access.

/** One shields.io "endpoint" badge: https://shields.io/badges/endpoint-badge */
export interface Badge {
	schemaVersion: 1;
	label: string;
	message: string;
	color: string;
}

export interface Tally {
	found: number;
	hit: number;
}

export interface Coverage {
	lines: Tally;
	branches: Tally;
	functions: Tally;
}

const FIELDS = {
	LF: ["lines", "found"],
	LH: ["lines", "hit"],
	BRF: ["branches", "found"],
	BRH: ["branches", "hit"],
	FNF: ["functions", "found"],
	FNH: ["functions", "hit"],
} as const;

/** Adds up the per-file totals of an lcov report. A report with no files gives zeros, which `percent` reads as 0%, never as 100%. */
export function parseLcov(text: string): Coverage {
	const total: Coverage = { lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
	for (const line of text.split("\n")) {
		const [key, value] = line.trim().split(":");
		const field = FIELDS[key as keyof typeof FIELDS];
		const count = Number(value);
		if (field && Number.isInteger(count) && count >= 0) total[field[0]][field[1]] += count;
	}
	return total;
}

/** A percentage of 0 to 100, rounded down so a badge never rounds a miss up to a pass. Nothing found means 0, not 100. */
export function percent(tally: Tally): number {
	if (tally.found <= 0) return 0;
	return Math.floor((Math.min(tally.hit, tally.found) / tally.found) * 100);
}

/** The lowest of lines, branches and functions: the number the 90% gate is about. */
export function lowestPercent(coverage: Coverage): number {
	return Math.min(percent(coverage.lines), percent(coverage.branches), percent(coverage.functions));
}

/** Green from the 90% the gate demands, then yellow, orange and red; an unproven 0 is never green. */
export function coverageColor(value: number): string {
	if (value >= 90) return "brightgreen";
	if (value >= 80) return "yellow";
	if (value >= 60) return "orange";
	return "red";
}

const badge = (label: string, message: string, color: string): Badge => ({ schemaVersion: 1, label, message, color });

export const coverageBadge = (coverage: Coverage): Badge => {
	const value = lowestPercent(coverage);
	return badge("coverage", `${value}%`, coverageColor(value));
};

/** The lowest coverage of several packages, for the root README; it names no package, so one weak package cannot hide. */
export const lowestCoverageBadge = (all: Coverage[]): Badge => {
	if (all.length === 0) return badge("coverage", "unknown", "lightgrey");
	const value = Math.min(...all.map(lowestPercent));
	return badge("coverage", `${value}%`, coverageColor(value));
};

/** The Node range a package declares in `engines.node`, as written, or a grey "unknown" when it declares none. */
export const nodeBadge = (range: string | undefined): Badge => (range ? badge("node", range, "blue") : badge("node", "unknown", "lightgrey"));

/** The pi range a package declares as a peer; CI tests its two ends, so this is a claim the pi floor and pi latest checks hold up. */
export const piBadge = (range: string | undefined): Badge => (range ? badge("pi", range, "blue") : badge("pi", "unknown", "lightgrey"));

/** How many runtime dependencies a package installs: zero is the best answer and is green, so a package that adds one shows it. */
export function dependenciesBadge(dependencies: Record<string, string> | undefined): Badge {
	const count = Object.keys(dependencies ?? {}).length;
	return badge("runtime dependencies", String(count), count === 0 ? "brightgreen" : count <= 3 ? "green" : "yellow");
}

export interface PackageFacts {
	/** Folder name under packages/. */
	dir: string;
	nodeRange: string | undefined;
	piRange: string | undefined;
	dependencies: Record<string, string> | undefined;
	/** The report of the package's coverage run, or undefined when the run left none. */
	lcov: string | undefined;
}

/** Every badge document to write, keyed by its path under the output folder. */
export function allBadges(packages: PackageFacts[]): Record<string, Badge> {
	const out: Record<string, Badge> = {};
	const measured: Coverage[] = [];
	for (const pkg of packages) {
		if (pkg.lcov !== undefined) {
			const coverage = parseLcov(pkg.lcov);
			measured.push(coverage);
			out[`${pkg.dir}/coverage.json`] = coverageBadge(coverage);
		}
		out[`${pkg.dir}/node.json`] = nodeBadge(pkg.nodeRange);
		out[`${pkg.dir}/pi.json`] = piBadge(pkg.piRange);
		out[`${pkg.dir}/dependencies.json`] = dependenciesBadge(pkg.dependencies);
	}
	// Only when every package measured: a root number built from some of them would hide the ones that did not report.
	if (measured.length === packages.length) out["coverage.json"] = lowestCoverageBadge(measured);
	return out;
}
