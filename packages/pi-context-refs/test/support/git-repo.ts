// Temporary git repositories for tests. Each call makes a real repository with no global or system configuration read.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/** The variables git sets for a hook (`git rev-parse --local-env-vars`) that say which repository to use. */
const REPOSITORY_VARIABLES =
	/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|IMPLICIT_WORK_TREE|SHALLOW_FILE|GRAFT_FILE)$/;

/**
 * `env` without the variables that point git at one repository. A hook (pre-push, in a worktree) sets
 * them, and a test that runs git in its own temporary repository would then talk to the wrong one.
 */
export function withoutRepositoryVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !REPOSITORY_VARIABLES.test(name)));
}

// The code under test runs git with the process environment too, so a test that loads this file starts clean.
for (const name of Object.keys(process.env)) if (REPOSITORY_VARIABLES.test(name)) delete process.env[name];

const isolatedEnv = () => ({
	...withoutRepositoryVariables(process.env),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
});

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: isolatedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Makes `dir` (and its parents) a git repository with the given remotes, `{ origin: "https://github.com/acme/app.git" }`. */
export function initRepo(dir: string, remotes: Record<string, string> = {}): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	for (const [name, url] of Object.entries(remotes)) git(dir, "remote", "add", name, url);
}
