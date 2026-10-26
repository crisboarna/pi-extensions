// Shared helpers for the repository check scripts. Node built-ins only, so the
// checks run before (and without) any dev dependency.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// REPO_CHECK_ROOT lets the repository tests run a check against a fixture tree.
export const ROOT = process.env.REPO_CHECK_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
export const SCOPE = "@crisboarna";
export const REPOSITORY_URL = "git+https://github.com/crisboarna/pi-extensions.git";

/** Packages that pi supplies at runtime. Extensions declare them as `"*"` peers, never as dependencies. */
export const HOST_PROVIDED = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"typebox",
	"@sinclair/typebox",
];

/** The parts of a package.json the checks read. */
export interface Manifest {
	name: string;
	version?: string;
	private?: boolean;
	description?: string;
	type?: string;
	license?: string;
	author?: string;
	keywords?: string[];
	repository?: { url?: string; directory?: string };
	homepage?: string;
	bugs?: { url?: string };
	publishConfig?: { access?: string; provenance?: boolean };
	engines?: Record<string, string>;
	files?: string[];
	bin?: Record<string, string>;
	scripts?: Record<string, string>;
	pi?: { extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[]; image?: string; video?: string };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
	/** Folder name under packages/. */
	dir: string;
	/** Absolute path to the package folder. */
	path: string;
	manifest: Manifest;
}

export function readJson<T = unknown>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Every workspace package under `packages/`, with its manifest. */
export function listPackages(): WorkspacePackage[] {
	const dir = join(ROOT, "packages");
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "package.json")))
		.map((entry) => {
			const path = join(dir, entry.name);
			return { dir: entry.name, path, manifest: readJson<Manifest>(join(path, "package.json")) };
		});
}

/** Tracked and untracked-but-not-ignored files, repository-relative with `/` separators. */
export function repoFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
	return out
		.split("\0")
		.filter(Boolean)
		.filter((file) => existsSync(join(ROOT, file)));
}

export function toRepoPath(path: string): string {
	return relative(ROOT, path).split(sep).join("/");
}

export interface Reporter {
	fail(message: string): void;
	finish(hint?: string): void;
}

/** Collects failures and prints them in one block, so a run reports every problem at once. */
export function reporter(name: string): Reporter {
	const failures: string[] = [];
	return {
		fail(message) {
			failures.push(message);
		},
		finish(hint) {
			if (failures.length === 0) {
				console.log(`${name}: ok`);
				return;
			}
			console.error(`${name}: ${failures.length} problem(s)`);
			for (const failure of failures) console.error(`  - ${failure}`);
			if (hint) console.error(`\n  How to fix: ${hint}`);
			process.exitCode = 1;
		},
	};
}
