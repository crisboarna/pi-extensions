// What decides whether `npm run coexist` may install a third-party package: the minimum age the repository's own .npmrc sets. The runner
// installs outside the repository, where that .npmrc does not apply, so it applies the same rule itself. Pure, so a test can check it.

export interface Pin {
	name: string;
	version: string;
}

/** The pins of scripts/coexist.json, checked for their shape. */
export function readPins(json: unknown): Pin[] {
	const packages = (json as { packages?: unknown } | null)?.packages;
	if (!Array.isArray(packages) || packages.length === 0) throw new Error('scripts/coexist.json must hold a non-empty "packages" list');
	return packages.map((entry, index) => {
		const pin = entry as Partial<Pin> | null;
		if (typeof pin?.name !== "string" || typeof pin.version !== "string")
			throw new Error(`scripts/coexist.json: packages[${index}] needs a "name" and a "version"`);
		if (!/^\d+\.\d+\.\d+$/.test(pin.version)) throw new Error(`scripts/coexist.json: ${pin.name} must be pinned to an exact version, not "${pin.version}"`);
		return { name: pin.name, version: pin.version };
	});
}

/** The `min-release-age` of an .npmrc, in days. */
export function minReleaseAgeDays(npmrc: string): number {
	const match = /^min-release-age=(\d+)\s*$/m.exec(npmrc);
	if (!match) throw new Error(".npmrc has no min-release-age");
	return Number(match[1]);
}

/** The pins that may not be installed, each with why: no publish time on the registry, or published less than `days` days before `now`. */
export function problemsWith(pins: Pin[], published: Record<string, string | undefined>, now: Date, days: number): string[] {
	const problems: string[] = [];
	for (const { name, version } of pins) {
		const key = `${name}@${version}`;
		const time = published[key];
		const at = time === undefined ? Number.NaN : Date.parse(time);
		if (Number.isNaN(at)) {
			problems.push(`${key} has no publish time on the registry`);
			continue;
		}
		const age = (now.getTime() - at) / 86_400_000;
		if (age < days) problems.push(`${key} was published ${age.toFixed(1)} days ago; the repository's .npmrc refuses packages younger than ${days} days`);
	}
	return problems;
}
