import { execFileSync } from "node:child_process";
import type { RemoteUrls } from "../core/place.ts";

/** Git must answer within this time or the place is undecidable (DESIGN.md section 7). */
const GIT_TIMEOUT_MS = 2000;

/**
 * The fetch URLs of every remote of the repository that contains `cwd`. A directory outside any repository and a
 * repository without remotes give an empty list; git that cannot run (missing binary, corrupt repository, timeout) gives a failure.
 * `env` is injectable so tests can run with a cleared PATH.
 */
export function readGitRemoteUrls(cwd: string, env: NodeJS.ProcessEnv = process.env): RemoteUrls {
	try {
		// `git remote -v` applies `url.<base>.insteadOf` rewrites, as a fetch would. LC_ALL=C pins the "not a git repository" text read below.
		const output = execFileSync("git", ["remote", "-v"], { cwd, env: { ...env, LC_ALL: "C" }, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, urls: fetchUrls(output) };
	} catch (error) {
		return readFailure(error);
	}
}

function fetchUrls(output: string): string[] {
	const urls = new Set<string>();
	for (const line of output.split("\n")) {
		const match = /^\S+\s+(.+) \(fetch\)$/.exec(line.trimEnd());
		if (match) urls.add(match[1]!);
	}
	return [...urls];
}

function readFailure(error: unknown): RemoteUrls {
	const failure = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string };
	if (failure.code === "ENOENT") return { ok: false, reason: "git is not installed or not on PATH" };
	if (failure.code === "ETIMEDOUT") return { ok: false, reason: `git did not answer within ${GIT_TIMEOUT_MS / 1000} s` };
	const stderr = String(failure.stderr ?? "");
	if (failure.status === 128 && stderr.includes("not a git repository")) return { ok: true, urls: [] };
	const detail = stderr.trim().split("\n")[0] || failure.message;
	return { ok: false, reason: `git failed: ${detail}` };
}
