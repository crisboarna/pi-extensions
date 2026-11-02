// What a README may claim, as rules a script can check (docs/conventions/readme.md). Pure, so a test can check every rule; the check script
// scripts/checks/readme.ts reads the files and the numbers they must agree with.

/** The most badges a README shows, on one line. */
export const MAX_BADGES = 8;

/** The one static badge that is allowed: a link to the try-it page, which states no measurement. */
const STATIC_BADGE_ALLOWED = "try it";

/** The versions a package README must state, in the words of the convention. */
export interface Expected {
	/** The Node floor as `major.minor`, from the package's `engines.node` (`>=22.19.0` is `22.19`). */
	node: string;
	/** The bottom of the pi range as `major.minor`, from `PI_PEER_RANGE`. */
	piMin: string;
	/** The first pi that is not allowed, as `major.minor`. */
	piBelow: string;
}

/** `22.19.0` as `22.19`. */
export function majorMinor(version: string): string {
	return version.split(".").slice(0, 2).join(".");
}

/** The hosts that serve badges. A linked image from one of them is a badge wherever it sits in a README. */
const BADGE_HOSTS =
	/^https:\/\/(?:img\.shields\.io|api\.scorecard\.dev|api\.securityscorecards\.dev|bestpractices\.coreinfrastructure\.org|bestpractices\.dev|codecov\.io|badge\.fury\.io)\//;

/**
 * The badges of a README, with their alt text and address: every linked image on the first line that starts with one (the badge line), and a
 * linked image from a badge host on any later line. A poster that links to a video is a linked image too, but it is not a badge.
 */
function badges(readme: string): Array<{ alt: string; src: string }> {
	const found: Array<{ alt: string; src: string }> = [];
	let badgeLineSeen = false;
	for (const line of readme.split("\n")) {
		if (!line.startsWith("[![")) continue;
		const onBadgeLine = !badgeLineSeen;
		badgeLineSeen = true;
		for (const match of line.matchAll(/\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(/g)) {
			const src = match[2] ?? "";
			if (onBadgeLine || BADGE_HOSTS.test(src)) found.push({ alt: match[1] ?? "", src });
		}
	}
	return found;
}

/** The ways a README breaks the badge rules: too many, or a value typed into a static badge instead of read from a registry, CI or the repository. */
export function badgeProblems(readme: string): string[] {
	const list = badges(readme);
	const problems: string[] = [];
	if (list.length > MAX_BADGES) problems.push(`has ${list.length} badges; the most is ${MAX_BADGES}`);
	for (const { alt, src } of list) {
		if (/^https:\/\/img\.shields\.io\/badge\//.test(src) && alt.toLowerCase() !== STATIC_BADGE_ALLOWED)
			problems.push(
				`badge "${alt}" has a value typed into its address (img.shields.io/badge/…), which goes stale; read it from a registry, CI or the repository`,
			);
	}
	return problems;
}

/** The sections every package README has, in this order (docs/conventions/readme.md). */
export const REQUIRED_HEADINGS = ["Requirements", "Data and privacy", "Uninstall"] as const;

/** The ways a package README lacks a section the convention requires, has them out of order, or does not link its upgrade notes. */
export function headingProblems(readme: string): string[] {
	const problems: string[] = [];
	const lines = readme.split("\n");
	const at = REQUIRED_HEADINGS.map((name) => lines.indexOf(`## ${name}`));
	REQUIRED_HEADINGS.forEach((name, index) => {
		if ((at[index] ?? -1) < 0) problems.push(`has no "## ${name}" section`);
	});
	const present = at.filter((index) => index >= 0);
	if (present.some((index, position) => position > 0 && index < (present[position - 1] ?? -1)))
		problems.push(`has its sections out of order; the order is ${REQUIRED_HEADINGS.join(", ")}`);
	if (!readme.includes("docs/upgrading.md")) problems.push("does not link docs/upgrading.md from its Reference section");
	return problems;
}

/** The ways a package README states the Node and pi versions other than the words of the convention, which come from the manifests. */
export function versionProblems(readme: string, expected: Expected): string[] {
	const problems: string[] = [];
	if (!readme.includes(`Node ${expected.node} or later`)) problems.push(`must say "Node ${expected.node} or later", the engines.node of the package`);
	const pi = `pi ${expected.piMin} up to, not including, ${expected.piBelow}`;
	if (!readme.includes(pi)) problems.push(`must say "${pi}", the range CI tests (PI_PEER_RANGE in scripts/lib/repo.ts)`);
	for (const match of readme.matchAll(/\bpi \d+\.\d+(?:\.\d+)? or later\b/g))
		problems.push(`says "${match[0]}"; a pi version needs an upper bound, so say "${pi}"`);
	return problems;
}
