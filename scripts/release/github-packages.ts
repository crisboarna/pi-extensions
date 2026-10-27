// Publishes the versions Changesets just published to npm to GitHub Packages
// as well, so they are listed under the repository's Packages. Run by the
// publish job in main.yml after `changeset publish`, with the published
// packages as JSON in PUBLISHED and a token with packages: write in
// GITHUB_TOKEN. npm stays the registry users install from; the GitHub copy
// carries no provenance (npm provenance exists only on npmjs.com). A version
// GitHub Packages already has is skipped, so a re-run is safe.
//
//   PUBLISHED='[{"name":"@crisboarna/pi-switchboard","version":"0.1.0"}]' node scripts/release/github-packages.ts
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, SCOPE } from "../lib/repo.ts";

export const GITHUB_REGISTRY = "https://npm.pkg.github.com";

export interface Published {
	name: string;
	version: string;
}

/** Each published package with the workspace folder it is published from; an unknown name is an error. */
export function githubPackagesPlan(published: Published[], workspaces: Record<string, string>): Array<Published & { folder: string }> {
	return published.map(({ name, version }) => {
		const folder = workspaces[name];
		if (!folder) throw new Error(`github-packages: ${name} is not a package of this repository`);
		return { name, version, folder };
	});
}

/** The npm user config for GitHub Packages: the scope's registry, and the token read from GITHUB_TOKEN when npm runs. */
export function githubNpmrc(scope = SCOPE): string {
	return `${scope}:registry=${GITHUB_REGISTRY}\n//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}\n`;
}

function workspaces(): Record<string, string> {
	const entries = readdirSync(join(ROOT, "packages")).map((folder) => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "packages", folder, "package.json"), "utf8")) as { name: string };
		return [manifest.name, `packages/${folder}`] as const;
	});
	return Object.fromEntries(entries);
}

function main(): void {
	if (!process.env.GITHUB_TOKEN) throw new Error("github-packages: GITHUB_TOKEN is not set");
	const plan = githubPackagesPlan(JSON.parse(process.env.PUBLISHED ?? "[]") as Published[], workspaces());
	const config = mkdtempSync(join(tmpdir(), "github-packages-"));
	const npmrc = join(config, ".npmrc");
	writeFileSync(npmrc, githubNpmrc());
	// This config replaces the npmjs.com one setup-node wrote, for these commands only.
	const env = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
	try {
		for (const { name, version, folder } of plan) {
			const existing = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry", GITHUB_REGISTRY], { cwd: ROOT, env, encoding: "utf8" });
			if (existing.status === 0 && existing.stdout.trim() === version) {
				console.log(`github-packages: ${name}@${version} is already published`);
				continue;
			}
			execFileSync("npm", ["publish", folder, "--registry", GITHUB_REGISTRY, "--provenance=false", "--ignore-scripts"], {
				cwd: ROOT,
				env,
				stdio: "inherit",
			});
			console.log(`github-packages: published ${name}@${version}`);
		}
	} finally {
		rmSync(config, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
