// Checks with GitHub that commits are signed and verified (GitHub's own
// verification, which also covers commits GitHub signs itself: merges, squash
// merges and the Changesets version commits). Runs in CI, where GH_TOKEN and
// GITHUB_REPOSITORY are set.
//
//   node scripts/checks/github-signatures.ts --pull <number>
//   node scripts/checks/github-signatures.ts --push <before-sha> <after-sha>
import { execFileSync } from "node:child_process";

interface Commit {
	sha: string;
	commit: { message: string; verification?: { verified: boolean; reason: string } };
}

const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !process.env.GH_TOKEN) {
	console.error("github-signatures: GITHUB_REPOSITORY and GH_TOKEN must be set (this check runs in CI).");
	process.exit(1);
}

function api(path: string): Commit[] {
	const out = execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const pages = JSON.parse(out) as Array<Commit[] | { commits: Commit[] }>;
	return pages.flatMap((page) => (Array.isArray(page) ? page : page.commits));
}

const [mode, first, second] = process.argv.slice(2);
let commits: Commit[];
if (mode === "--pull" && first) commits = api(`repos/${repository}/pulls/${first}/commits?per_page=100`);
else if (mode === "--push" && first && second) {
	commits = /^0+$/.test(first) ? api(`repos/${repository}/commits?sha=${second}&per_page=100`) : api(`repos/${repository}/compare/${first}...${second}`);
} else {
	console.error("Usage: github-signatures.ts --pull <number> | --push <before> <after>");
	process.exit(1);
}

const bad = commits.filter((entry) => entry.commit.verification?.verified !== true);
if (bad.length > 0) {
	console.error(`github-signatures: ${bad.length} of ${commits.length} commit(s) are not signed and verified:`);
	for (const entry of bad)
		console.error(`  - ${entry.sha.slice(0, 7)} ${entry.commit.message.split("\n")[0]} (${entry.commit.verification?.reason ?? "no verification"})`);
	console.error("\n  How to fix: sign your commits with a key registered on GitHub as a signing key; see CONTRIBUTING.md.");
	process.exitCode = 1;
} else console.log(`github-signatures: ok (${commits.length} commit(s) verified)`);
