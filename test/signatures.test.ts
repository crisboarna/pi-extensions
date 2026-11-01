// The pre-push signature check (scripts/checks/signatures.ts) against a fixture repository with real SSH-signed commits.
// It must refuse a commit that is on no remote and carries no valid signature, and it must not ask for signatures on commits
// that already exist on a remote: a branch that merged main holds main's own commits, which GitHub signs with its own key.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/checks/signatures.ts", import.meta.url));
const ZERO = "0".repeat(40);
// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends; they would point the fixture's git commands at the repository being pushed.
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** git in `cwd`, ignoring the user's own git configuration (their signing key, hooks path, aliases). */
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

interface Fixture {
	root: string;
	/** Makes an empty commit signed with the allowed key (`allowed`), the unlisted key (`other`), or not signed at all. */
	commit(message: string, signer: "allowed" | "other" | "none"): string;
	/** Points a remote-tracking ref at a commit, as a fetch or a push does. */
	remoteAt(ref: string, sha: string): void;
	branch(name: string, from: string): void;
	switchTo(name: string): void;
	/** Merges `name` into the current branch with a merge commit signed with the allowed key. */
	merge(name: string): string;
	/** Runs `--pre-push` with the lines git would send. */
	prePush(...lines: string[]): { ok: boolean; output: string };
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "signatures-check-"));
	made.push(root);
	const keys = join(root, ".keys");
	mkdirSync(keys);
	const keyFor = (name: string) => {
		const path = join(keys, name);
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${name}@test`, "-f", path]);
		const [type, key] = readFileSync(`${path}.pub`, "utf8").trim().split(" ");
		return { path, signer: `${name}@test ${type} ${key}` };
	};
	const allowed = keyFor("allowed");
	const other = keyFor("other");
	mkdirSync(join(root, ".github"));
	writeFileSync(join(root, ".github", "allowed_signers"), `${allowed.signer}\n`);
	git(root, ["init", "-q", "-b", "main"]);
	for (const [key, value] of [
		["user.name", "Test"],
		["user.email", "test@example.com"],
		["gpg.format", "ssh"],
		["commit.gpgsign", "false"],
	] as const)
		git(root, ["config", key, value]);
	let count = 0;
	const signedWith = (path: string) => ["-c", `user.signingkey=${path}`, "-c", "commit.gpgsign=true"];
	return {
		root,
		commit(message, signer) {
			count++;
			const flags = signer === "none" ? [] : signedWith(signer === "allowed" ? allowed.path : other.path);
			git(root, [...flags, "commit", "-q", "--allow-empty", "-m", `${message} ${count}`]);
			return git(root, ["rev-parse", "HEAD"]);
		},
		remoteAt: (ref, sha) => void git(root, ["update-ref", `refs/remotes/${ref}`, sha]),
		branch: (name, from) => void git(root, ["branch", name, from]),
		switchTo: (name) => void git(root, ["switch", "-q", name]),
		merge(name) {
			git(root, [...signedWith(allowed.path), "merge", "-q", "--no-ff", "-m", `merge ${name}`, name]);
			return git(root, ["rev-parse", "HEAD"]);
		},
		prePush(...lines) {
			const result = spawnSync(process.execPath, [SCRIPT, "--pre-push"], {
				env: { ...process.env, REPO_CHECK_ROOT: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
				input: `${lines.join("\n")}\n`,
				encoding: "utf8",
			});
			return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
		},
	};
}

describe("the pre-push signature check", () => {
	test("refuses a commit that is on no remote and has no valid signature, and names it", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		repo.remoteAt("origin/main", base);
		const unsigned = repo.commit("unsigned work", "none");
		const result = repo.prePush(`refs/heads/main ${unsigned} refs/heads/main ${base}`);
		assert.ok(!result.ok, result.output);
		assert.match(result.output, new RegExp(`${unsigned.slice(0, 7)} unsigned work`));
		assert.match(result.output, /1 commit\(s\) without a valid signature/);
	});

	test("refuses a commit signed with a key that is not in allowed_signers", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		repo.remoteAt("origin/main", base);
		const stranger = repo.commit("signed by someone else", "other");
		const result = repo.prePush(`refs/heads/main ${stranger} refs/heads/main ${base}`);
		assert.ok(!result.ok, result.output);
		assert.match(result.output, /signed by someone else/);
	});

	test("passes a commit signed with an allowed key", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		repo.remoteAt("origin/main", base);
		const work = repo.commit("work", "allowed");
		const result = repo.prePush(`refs/heads/main ${work} refs/heads/main ${base}`);
		assert.ok(result.ok, result.output);
		assert.match(result.output, /signatures: ok \(1 commit\(s\)\)/);
	});

	test("does not ask for a signature on main's own commits when a branch that already exists on the remote has merged main", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		repo.remoteAt("origin/main", base);
		repo.branch("feature", base);
		repo.switchTo("feature");
		const pushedTip = repo.commit("feature work", "allowed");
		repo.remoteAt("origin/feature", pushedTip);
		// main moves on: GitHub squash-merges a pull request and signs the commit with a key that is not in allowed_signers
		repo.switchTo("main");
		const githubs = repo.commit("a squash merge signed by GitHub", "other");
		repo.remoteAt("origin/main", githubs);
		repo.switchTo("feature");
		const merged = repo.merge("main");
		const result = repo.prePush(`refs/heads/feature ${merged} refs/heads/feature ${pushedTip}`);
		assert.ok(result.ok, result.output);
		assert.match(result.output, /signatures: ok \(1 commit\(s\)\)/, "only the merge commit is new");
	});

	test("still checks every commit that is on no remote when the branch already exists on the remote", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		repo.remoteAt("origin/main", base);
		repo.branch("feature", base);
		repo.switchTo("feature");
		const pushedTip = repo.commit("feature work", "allowed");
		repo.remoteAt("origin/feature", pushedTip);
		const first = repo.commit("new and unsigned", "none");
		const second = repo.commit("new and signed", "allowed");
		const result = repo.prePush(`refs/heads/feature ${second} refs/heads/feature ${pushedTip}`);
		assert.ok(!result.ok, result.output);
		assert.match(result.output, new RegExp(`${first.slice(0, 7)} new and unsigned`));
		assert.doesNotMatch(result.output, /new and signed/);
	});

	test("checks a new remote branch the same way", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		repo.remoteAt("origin/main", base);
		const work = repo.commit("work", "none");
		const result = repo.prePush(`refs/heads/topic ${work} refs/heads/topic ${ZERO}`);
		assert.ok(!result.ok, result.output);
		assert.match(result.output, /work/);
	});

	test("skips a delete push", () => {
		const repo = fixture();
		const base = repo.commit("base", "allowed");
		const result = repo.prePush(`(delete) ${ZERO} refs/heads/old ${base}`);
		assert.ok(result.ok, result.output);
		assert.match(result.output, /signatures: ok \(0 commit\(s\)\)/);
	});
});
