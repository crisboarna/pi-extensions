// The git volumes a Dockerised tool needs (scripts/lib/docker.ts). In a linked worktree `.git` is a file naming a directory inside
// the main repository's `.git`; without that directory in the container, gitleaks scans 0 commits and still reports no leaks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gitMounts } from "../scripts/lib/docker.ts";

for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
}

/** A temporary directory holding a repository with one commit in `main/`. */
function repository(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "git-mounts-")));
	made.push(root);
	const main = join(root, "main");
	mkdirSync(main);
	git(main, ["init", "--quiet", "--initial-branch=main"]);
	git(main, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "first"]);
	return root;
}

describe("gitMounts", () => {
	test("a main checkout needs nothing beyond the repository itself", () => {
		const root = repository();
		assert.deepEqual(gitMounts(join(root, "main")), []);
	});

	test("a linked worktree mounts the main repository's .git read-only at the same path", () => {
		const root = repository();
		git(join(root, "main"), ["worktree", "add", "--quiet", join(root, "linked")]);
		const common = join(root, "main", ".git");
		assert.deepEqual(gitMounts(join(root, "linked")), [`${common}:${common}:ro`]);
	});

	test("a .git file that names a missing directory fails instead of scanning nothing", () => {
		const broken = realpathSync(mkdtempSync(join(tmpdir(), "git-mounts-broken-")));
		made.push(broken);
		writeFileSync(join(broken, ".git"), `gitdir: ${join(broken, "nowhere")}\n`);
		assert.throws(() => gitMounts(broken), /nowhere/);
	});
});
