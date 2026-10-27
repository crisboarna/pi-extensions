// Publishes the versions Changesets just published to npm to GitHub Packages
// as well, so they are listed under the repository's Packages, with a GitHub
// artifact attestation (SLSA build provenance) in place of npm's provenance,
// which only npmjs.com stores. Run by the publish job in main.yml after
// `changeset publish`, in two steps around the attest action:
//
//   pack     packs each published package into .release/, and says whether
//            the file is byte for byte the one npmjs.com now serves (then the
//            attestation covers that copy too)
//   publish  publishes those same files to GitHub Packages, skipping a
//            version that is already there, so a re-run is safe
//
// The published packages come as JSON in PUBLISHED; publish needs a token
// with packages: write in GITHUB_TOKEN.
//
//   PUBLISHED='[{"name":"@crisboarna/pi-switchboard","version":"0.1.0"}]' node scripts/release/github-packages.ts pack
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		// "./" keeps npm from reading "packages/<folder>" as a GitHub repository.
		return [manifest.name, `./packages/${folder}`] as const;
	});
	return Object.fromEntries(entries);
}

/** Where the packed files and their list wait between the two steps. */
export const RELEASE_DIR = ".release";
const LIST = "packages.json";

interface Packed extends Published {
	file: string;
	integrity: string;
}

/** Whether a packed file is the one npmjs.com serves for its version, compared by integrity (sha512). */
export function sameAsNpm(packed: { integrity: string }, npmIntegrity: string | undefined): boolean {
	return npmIntegrity !== undefined && npmIntegrity.trim() === packed.integrity;
}

function pack(): void {
	const plan = githubPackagesPlan(JSON.parse(process.env.PUBLISHED ?? "[]") as Published[], workspaces());
	const dir = join(ROOT, RELEASE_DIR);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const packed: Packed[] = plan.map(({ name, version, folder }) => {
		const [result] = JSON.parse(
			execFileSync("npm", ["pack", folder, "--pack-destination", dir, "--ignore-scripts", "--json"], { cwd: ROOT, encoding: "utf8" }),
		) as Array<{ filename: string; integrity: string }>;
		if (!result) throw new Error(`github-packages: npm pack gave no file for ${name}`);
		const npm = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--registry", "https://registry.npmjs.org"], {
			cwd: ROOT,
			encoding: "utf8",
		});
		const onNpm = npm.status === 0 ? npm.stdout : undefined;
		const note =
			onNpm === undefined
				? "not found on npmjs.com"
				: sameAsNpm(result, onNpm)
					? "the same file as on npmjs.com, so the attestation covers that copy too"
					: "differs from npmjs.com, whose own provenance covers that copy";
		console.log(`github-packages: packed ${result.filename}; ${note}`);
		return { name, version, file: result.filename, integrity: result.integrity };
	});
	writeFileSync(join(dir, LIST), `${JSON.stringify(packed, null, "\t")}\n`);
}

function publish(): void {
	if (!process.env.GITHUB_TOKEN) throw new Error("github-packages: GITHUB_TOKEN is not set");
	const dir = join(ROOT, RELEASE_DIR);
	const packed = JSON.parse(readFileSync(join(dir, LIST), "utf8")) as Packed[];
	const config = mkdtempSync(join(tmpdir(), "github-packages-"));
	const npmrc = join(config, ".npmrc");
	writeFileSync(npmrc, githubNpmrc());
	// This config replaces the npmjs.com one setup-node wrote, for these commands only.
	const env = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
	try {
		for (const { name, version, file } of packed) {
			const existing = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry", GITHUB_REGISTRY], { cwd: ROOT, env, encoding: "utf8" });
			if (existing.status === 0 && existing.stdout.trim() === version) {
				console.log(`github-packages: ${name}@${version} is already published`);
				continue;
			}
			execFileSync("npm", ["publish", join(dir, file), "--registry", GITHUB_REGISTRY, "--provenance=false", "--ignore-scripts"], {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const step = process.argv[2];
	if (step === "pack") pack();
	else if (step === "publish") publish();
	else throw new Error("usage: node scripts/release/github-packages.ts pack|publish");
}
