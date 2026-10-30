// Temporary git repositories for tests. Each call makes a real repository with no global or system configuration read.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const ISOLATED_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: ISOLATED_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Makes `dir` (and its parents) a git repository with the given remotes, `{ origin: "https://github.com/acme/app.git" }`. */
export function initRepo(dir: string, remotes: Record<string, string> = {}): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	for (const [name, url] of Object.entries(remotes)) git(dir, "remote", "add", name, url);
}
