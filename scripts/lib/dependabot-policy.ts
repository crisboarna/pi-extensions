// Decides whether a Dependabot pull request may merge itself once every required check is green. Pure, so a test can try every case; the workflow
// in `.github/workflows/dependabot-auto-merge.yml` only passes in what `dependabot/fetch-metadata` reports and acts on the answer.
//
// What may merge itself: GitHub Actions and Docker updates (never a major), and development-only npm updates that are a patch, or a minor of a package
// that is already at 1.0 or later. What never does: anything that changes the pi versions the suites run against, a runtime dependency, a major, a
// minor of a 0.x package (0.x minors may break), and any update the metadata does not describe well enough to judge. The default is "no": a pull
// request the policy does not understand stays open for the maintainer.

/** One entry of `updated-dependencies-json` from `dependabot/fetch-metadata`; the fields this policy reads. */
export interface UpdatedDependency {
	dependencyName?: string | undefined;
	dependencyType?: string | undefined;
	updateType?: string | undefined;
	packageEcosystem?: string | undefined;
	prevVersion?: string | undefined;
}

/** Packages that decide which pi the suites run against; the same patterns as the `pi-host` group in `.github/dependabot.yml`. */
export const PI_HOST_PATTERNS = ["@earendil-works/*", "typebox", "jiti"];

export interface Decision {
	allowed: boolean;
	reason: string;
}

const MAJOR = "version-update:semver-major";
const MINOR = "version-update:semver-minor";
const PATCH = "version-update:semver-patch";

/** True when `name` matches a pattern that is a name, or a scope followed by `/*`. */
export function matchesPattern(name: string, pattern: string): boolean {
	return pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function ecosystem(dep: UpdatedDependency): string {
	return (dep.packageEcosystem ?? "").toLowerCase().replaceAll("-", "_");
}

/** The first number of a version, or undefined when it does not start with one. */
function majorOf(version: string | undefined): number | undefined {
	const match = /^v?(\d+)\./.exec(version ?? "");
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

function judge(dep: UpdatedDependency): Decision {
	const name = dep.dependencyName ?? "(unnamed)";
	const no = (reason: string): Decision => ({ allowed: false, reason: `${name}: ${reason}` });
	if (dep.dependencyName === undefined) return no("the update has no name");
	if (PI_HOST_PATTERNS.some((pattern) => matchesPattern(dep.dependencyName ?? "", pattern))) return no("it decides which pi the suites run against");
	if (dep.updateType === MAJOR) return no("it is a major update");
	const kind = ecosystem(dep);
	if (kind === "github_actions" || kind === "docker") return { allowed: true, reason: `${name}: a ${kind.replace("_", " ")} update that is not a major` };
	if (kind !== "npm_and_yarn" && kind !== "npm") return no(`the ecosystem "${dep.packageEcosystem ?? ""}" is not one the policy covers`);
	if (dep.dependencyType !== "direct:development") return no("it is not a direct development dependency");
	if (dep.updateType === PATCH) return { allowed: true, reason: `${name}: a patch of a development dependency` };
	if (dep.updateType === MINOR) {
		const major = majorOf(dep.prevVersion);
		if (major !== undefined && major >= 1) return { allowed: true, reason: `${name}: a minor of a development dependency at ${dep.prevVersion}` };
		return no(`a minor of a package below 1.0 (from ${dep.prevVersion ?? "an unknown version"}), which may break`);
	}
	return no(`the update type "${dep.updateType ?? ""}" is not a patch or a minor`);
}

/** Every update in the pull request must be allowed, and there must be at least one. */
export function decide(dependencies: UpdatedDependency[]): Decision {
	if (dependencies.length === 0) return { allowed: false, reason: "the pull request lists no updated dependencies" };
	const decisions = dependencies.map(judge);
	const refused = decisions.filter((decision) => !decision.allowed);
	if (refused.length > 0) return { allowed: false, reason: refused.map((decision) => decision.reason).join("; ") };
	return { allowed: true, reason: decisions.map((decision) => decision.reason).join("; ") };
}

/** Reads the JSON the metadata step produced; anything that is not a list of objects counts as no information. */
export function parseDependencies(json: string | undefined): UpdatedDependency[] {
	if (json === undefined || json === "") return [];
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is UpdatedDependency => typeof item === "object" && item !== null && !Array.isArray(item));
}
