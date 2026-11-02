// Which version of pi a compatibility run uses. The repository tests against one pi, the one it pins, but the packages declare a range of pi
// they work with, so CI also runs the whole suite against the floor of that range, the newest version inside it, and the newest version
// there is. This module picks the version; scripts/pi-host.ts installs it. Pure, so a test can check every rule.
import { problemsWith } from "./coexist-pins.ts";

/** The packages pi publishes at one version each, which a run must install together so that there is one copy of pi. */
export const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/pi-agent-core"] as const;

const STABLE = /^\d+\.\d+\.\d+$/;

export interface PiRange {
	/** The lowest version the range allows. */
	min: string;
	/** The first version it does not allow. */
	below: string;
}

/** The range of the form `>=1.4.0 <2`, as the two versions that bound it. */
export function parseRange(range: string): PiRange {
	const match = /^>=(\d+\.\d+\.\d+) <(\d+)(?:\.0\.0)?$/.exec(range.trim());
	if (!match?.[1] || !match[2]) throw new Error(`the pi range must look like ">=1.4.0 <2", not "${range}"`);
	return { min: match[1], below: `${match[2]}.0.0` };
}

/** Orders two `x.y.z` versions: negative when `a` is older, zero when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The newest of `versions`, or undefined when there are none. */
function newest(versions: string[]): string | undefined {
	return versions.reduce<string | undefined>((best, version) => (best === undefined || compareVersions(version, best) > 0 ? version : best), undefined);
}

export interface ResolveOptions {
	/** The registry's `time` map for the pi packages: every version with its publish time. */
	times: Record<string, string | undefined>;
	/** The version range the packages declare. */
	range: PiRange;
	now: Date;
	/** The repository's `min-release-age`, in days. */
	days: number;
	/** Whether a version younger than `days` may be used. Only a run that is meant to catch a pi release on its first day sets it. */
	allowYoung: boolean;
}

/**
 * The version of pi `spec` stands for: `floor` (the bottom of the range), `latest` (the newest release inside the range that is old enough),
 * `newest` (the newest release there is, inside the range or not, which needs `allowYoung`) or an exact `x.y.z`. Throws, saying why, when
 * the spec stands for no usable version.
 */
export function resolvePi(spec: string, { times, range, now, days, allowYoung }: ResolveOptions): string {
	const stable = Object.keys(times).filter((version) => STABLE.test(version));
	const problemsOf = (version: string): string[] =>
		allowYoung ? [] : problemsWith([{ name: PI_PACKAGES[0], version }], { [`${PI_PACKAGES[0]}@${version}`]: times[version] }, now, days);
	const checkAge = (version: string): string => {
		const problems = problemsOf(version);
		if (problems.length > 0) throw new Error(problems.join("; "));
		return version;
	};
	if (spec === "floor") {
		if (!stable.includes(range.min)) throw new Error(`the floor of the range, ${range.min}, is not a published version of pi`);
		return checkAge(range.min);
	}
	if (spec === "latest") {
		const inRange = stable.filter((version) => compareVersions(version, range.min) >= 0 && compareVersions(version, range.below) < 0);
		const best = newest(inRange.filter((version) => problemsOf(version).length === 0));
		if (best === undefined) throw new Error(`no published version of pi is inside ${range.min} to below ${range.below} and old enough`);
		return best;
	}
	if (spec === "newest") {
		if (!allowYoung) throw new Error('"newest" ignores min-release-age, so it needs --allow-young');
		const best = newest(stable);
		if (best === undefined) throw new Error("the registry lists no stable version of pi");
		return best;
	}
	if (!STABLE.test(spec)) throw new Error(`"${spec}" is not floor, latest, newest or an exact version like 1.4.0`);
	if (!stable.includes(spec)) throw new Error(`pi ${spec} is not a published version`);
	return checkAge(spec);
}
