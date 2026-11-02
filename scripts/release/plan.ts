// Says what a release would publish, and stops it before the publish job when a release is half done or a version is wrong. npm cannot unpublish
// a version and a git tag cannot be reused, so every mistake found here is one that would otherwise be permanent. Run for the release pull
// request (`changeset-release/main`) by pr.yml, and on demand by release-dry-run.yml:
//
//   node scripts/release/plan.ts               check the plan, then `npm publish --dry-run` for each package it would publish
//   node scripts/release/plan.ts --no-dry-run  check the plan only
//
// It reads the packages, `npm view` and `git tag --list`, and publishes and tags nothing. The dry run needs no npm login and no provenance.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { listPackages, ROOT } from "../lib/repo.ts";

export interface PackageFacts {
	name: string;
	version: string;
	private?: boolean;
}

export interface RegistryFacts {
	/** The versions npm holds, by package name; a package that was never published has none. */
	published: Record<string, string[]>;
	/** Every git tag of the repository. Changesets tags a release `name@version`. */
	tags: string[];
}

export interface ReleasePlan {
	/** The versions npm does not hold yet and nothing is wrong with. */
	toPublish: Array<{ name: string; version: string }>;
	/** The versions npm already holds, with their tag. */
	alreadyPublished: Array<{ name: string; version: string }>;
	problems: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Orders two x.y.z versions as numbers: negative when `a` is older. */
function compare(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The newest of `versions` that is a plain x.y.z, or undefined. */
function newest(versions: string[]): string | undefined {
	return versions
		.filter((version) => SEMVER.test(version))
		.reduce<string | undefined>((best, version) => (best === undefined || compare(version, best) > 0 ? version : best), undefined);
}

/** What a release of `packages` would do, and what is wrong with it. Pure: every fact it needs is passed in. */
export function releasePlan(packages: PackageFacts[], { published, tags }: RegistryFacts): ReleasePlan {
	const plan: ReleasePlan = { toPublish: [], alreadyPublished: [], problems: [] };
	for (const { name, version, private: isPrivate } of packages) {
		if (isPrivate === true) continue;
		const tag = `${name}@${version}`;
		if (!SEMVER.test(version)) {
			plan.problems.push(`${name}: version "${version}" must look like 1.2.3`);
			continue;
		}
		const held = published[name] ?? [];
		if (held.includes(version)) {
			if (tags.includes(tag)) plan.alreadyPublished.push({ name, version });
			else
				plan.problems.push(
					`${name}: ${version} is on npm but has no git tag ${tag}; a publish stopped before the tag. Tag the commit that was published, then run again`,
				);
			continue;
		}
		if (tags.includes(tag)) {
			plan.problems.push(
				`${name}: tag ${tag} exists, but npm does not hold ${version}; a release stopped half way. Delete the tag, or publish ${version}`,
			);
			continue;
		}
		const latest = newest(held);
		if (latest !== undefined && compare(version, latest) <= 0) {
			plan.problems.push(`${name}: ${version} is not newer than ${latest}, the newest on npm`);
			continue;
		}
		plan.toPublish.push({ name, version });
	}
	return plan;
}

/** The versions npm holds for a package; a package npm has never seen holds none. */
function npmVersions(name: string): string[] {
	const result = spawnSync("npm", ["view", name, "versions", "--json", "--registry", "https://registry.npmjs.org"], { cwd: ROOT, encoding: "utf8" });
	if (result.status !== 0) {
		if (/E404|404 Not Found/u.test(result.stderr + result.stdout)) return [];
		throw new Error(`release plan: npm view ${name} failed: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
	}
	const parsed = JSON.parse(result.stdout) as string | string[];
	return Array.isArray(parsed) ? parsed : [parsed];
}

function main(): void {
	const dryRun = !process.argv.includes("--no-dry-run");
	const packages = listPackages().map(({ manifest }) => ({
		name: manifest.name,
		version: manifest.version ?? "",
		...(manifest.private === true ? { private: true } : {}),
	}));
	const published = Object.fromEntries(packages.filter((p) => p.private !== true).map((p) => [p.name, npmVersions(p.name)]));
	const tags = execFileSync("git", ["tag", "--list"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
	const plan = releasePlan(packages, { published, tags });
	for (const { name, version } of plan.alreadyPublished) console.log(`release plan: ${name}@${version} is already published and tagged`);
	for (const { name, version } of plan.toPublish) console.log(`release plan: ${name}@${version} would be published`);
	if (plan.problems.length > 0) {
		console.error(`release plan: ${plan.problems.length} problem(s)`);
		for (const problem of plan.problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	if (!dryRun) return;
	for (const { name, version } of plan.toPublish) {
		console.log(`release plan: npm publish --dry-run ${name}@${version}`);
		const run = spawnSync("npm", ["publish", "--dry-run", "--ignore-scripts", "--provenance=false", "--access", "public", "--workspace", name], {
			cwd: ROOT,
			stdio: "inherit",
		});
		if (run.status !== 0) {
			console.error(`release plan: npm publish --dry-run failed for ${name}@${version}`);
			process.exit(1);
		}
	}
	console.log("release plan: ok");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
