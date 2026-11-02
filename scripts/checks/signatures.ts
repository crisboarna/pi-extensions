// Checks that commits carry a valid signature from a key in
// .github/allowed_signers, so every commit on main is traceable to its author.
// GitHub's branch ruleset ("require signed commits") is the final gate; this
// catches unsigned commits before they are pushed.
//
//   node scripts/checks/signatures.ts --range <base>..<head>
//   node scripts/checks/signatures.ts --pre-push      (reads git's pre-push lines from stdin)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/repo.ts";

const ZERO = /^0+$/;
const SIGNERS = join(ROOT, ".github", "allowed_signers");

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * Commits to check for each ref being pushed: new commits not already on any remote. The remote tip git reports for the ref is not
 * used: `remote..local` would also list a commit that came in by merging main, and GitHub signs main's commits with its own key.
 */
function prePushCommits(input: string): string[] {
	const out: string[] = [];
	for (const line of input.split("\n").filter(Boolean)) {
		const [, localSha = ""] = line.split(" ");
		if (ZERO.test(localSha)) continue;
		out.push(...git(["rev-list", localSha, "--not", "--remotes"]).split("\n").filter(Boolean));
	}
	return [...new Set(out)];
}

const rangeIndex = process.argv.indexOf("--range");
const commits =
	rangeIndex !== -1
		? git(["rev-list", process.argv[rangeIndex + 1] ?? "HEAD"])
				.split("\n")
				.filter(Boolean)
		: prePushCommits(readFileSync(0, "utf8"));

const unsigned: string[] = [];
for (const sha of commits) {
	const verify = spawnSync("git", ["-c", `gpg.ssh.allowedSignersFile=${SIGNERS}`, "verify-commit", sha], { cwd: ROOT, encoding: "utf8" });
	if (verify.status !== 0) unsigned.push(`${sha.slice(0, 7)} ${git(["log", "-1", "--format=%s", sha])}`);
}

if (unsigned.length > 0) {
	console.error(`signatures: ${unsigned.length} commit(s) without a valid signature from .github/allowed_signers:`);
	for (const line of unsigned) console.error(`  - ${line}`);
	console.error(
		"\n  How to fix: sign commits (git config commit.gpgsign true, gpg.format ssh, user.signingkey <key.pub>),\n  add the key to .github/allowed_signers and to GitHub as a signing key, then re-sign: git rebase --exec 'git commit --amend --no-edit -S' <base>.",
	);
	process.exitCode = 1;
} else console.log(`signatures: ok (${commits.length} commit(s))`);
