import { execFileSync } from "node:child_process";

/** Git must answer within this time, or its remotes are unknown. */
const GIT_TIMEOUT_MS = 2000;

/**
 * The fetch URLs of every remote of the repository that contains `cwd`. A directory outside any repository and a repository
 * without remotes give an empty list; git that cannot run (not installed, a corrupt repository, a timeout) gives undefined.
 */
export function readRemoteUrls(cwd: string): string[] | undefined {
	try {
		// `git remote -v` applies `url.<base>.insteadOf` rewrites, as a fetch would. LC_ALL=C pins the "not a git repository" text read below.
		const output = execFileSync("git", ["remote", "-v"], {
			cwd,
			env: { ...process.env, LC_ALL: "C" },
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return fetchUrls(output);
	} catch (error) {
		const failure = error as { status?: number | null; stderr?: string };
		return failure.status === 128 && String(failure.stderr ?? "").includes("not a git repository") ? [] : undefined;
	}
}

/** The fetch URLs, `origin` first, each once. */
function fetchUrls(output: string): string[] {
	const urls = new Set<string>();
	let origin: string | undefined;
	for (const line of output.split("\n")) {
		const match = /^(\S+)\s+(.+) \(fetch\)$/.exec(line.trimEnd());
		if (!match?.[2]) continue;
		if (match[1] === "origin") origin = match[2];
		else urls.add(match[2]);
	}
	return origin === undefined ? [...urls] : [origin, ...[...urls].filter((url) => url !== origin)];
}
