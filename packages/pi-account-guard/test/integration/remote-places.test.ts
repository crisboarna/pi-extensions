import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { realpathIfPresent } from "../../src/pi/fs.ts";
import { readGitRemoteUrls } from "../../src/pi/git.ts";
import { registerGuard } from "../../src/pi/hooks.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends. Run from a hook, every git call below would act on the
// repository being pushed instead of the temporary ones, so drop them before any test runs git.
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
// Real git in temporary directories; the guard sees a work-only account, so a place in zone personal Blocks.
const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-remotes-")));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(name: string, remotes: Record<string, string> = {}): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "--quiet");
	for (const [remote, url] of Object.entries(remotes)) git(dir, "remote", "add", remote, url);
	return dir;
}

function plainDirectory(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

type Rule = { path?: string; remote?: string; zone: string };

/** Runs one session start and one input in `cwd`; returns the stderr text, empty when the turn passed. */
async function turn(cwd: string, places: Rule[], env: NodeJS.ProcessEnv = process.env): Promise<{ stderr: string; passed: boolean }> {
	const host = createFakeHost();
	let stderr = "";
	const config = { accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }], places };
	registerGuard(host.pi as never, {
		home: "/home/me",
		configPath: "/home/me/.pi/agent/account-guard.json",
		readConfigText: () => JSON.stringify(config),
		realpath: realpathIfPresent,
		readRemoteUrls: (dir) => readGitRemoteUrls(dir, env),
		writeStderr: (text) => {
			stderr += text;
		},
		setExitCode: () => {},
	});
	const session = createFakeSession({ cwd });
	await host.fire("session_start", { reason: "startup" }, session.ctx);
	const result = await host.fire("input", { text: "hello", source: "interactive" }, session.ctx);
	return { stderr, passed: result === undefined };
}

const noGit = { ...process.env, PATH: join(root, "no-such-bin") };
const workRemote: Rule = { remote: "*/Acme/*", zone: "work" };

describe("remote place rules with real git", () => {
	it("matches a remote-only rule on origin, whatever the url form", async () => {
		for (const [index, url] of ["git@github.com:Acme/api.git", "https://github.com/Acme/api.git", "ssh://git@github.com/acme/api"].entries()) {
			const dir = repo(`form-${index}`, { origin: url });
			assert.equal((await turn(dir, [workRemote])).passed, true, url);
		}
	});

	it("matches when any of two remotes matches", async () => {
		const dir = repo("two-remotes", { origin: "https://github.com/me/fork.git", upstream: "git@github.com:Acme/api.git" });
		assert.equal((await turn(dir, [workRemote])).passed, true);
	});

	it("does not match a remote rule for another repository", async () => {
		const dir = repo("other-remote", { origin: "https://github.com/me/site.git" });
		assert.match((await turn(dir, [workRemote])).stderr, /is zone personal/);
	});

	it("matches from a subdirectory of the repository", async () => {
		const dir = repo("nested", { origin: "git@github.com:Acme/api.git" });
		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		assert.equal((await turn(join(dir, "src", "deep"), [workRemote])).passed, true);
	});

	it("requires both conditions of a combined rule", async () => {
		const dir = repo("combined", { origin: "git@github.com:Acme/api.git" });
		assert.equal((await turn(dir, [{ path: dir, remote: "*/Acme/*", zone: "work" }])).passed, true);
		assert.equal((await turn(dir, [{ path: join(root, "elsewhere"), remote: "*/Acme/*", zone: "work" }])).passed, false);
	});

	it("lets the first matching rule win", async () => {
		const dir = repo("first-wins", { origin: "git@github.com:Acme/api.git" });
		const result = await turn(dir, [
			{ remote: "*/Acme/*", zone: "personal" },
			{ path: dir, zone: "work" },
		]);
		assert.match(result.stderr, /is zone personal/);
	});

	it("treats a repository without remotes as decidable: remote rules miss, path rules apply", async () => {
		const dir = repo("no-remote");
		assert.match((await turn(dir, [workRemote])).stderr, /is zone personal/);
		assert.equal((await turn(dir, [workRemote, { path: dir, zone: "work" }])).passed, true);
	});

	it("treats a directory outside any repository as decidable", async () => {
		const dir = plainDirectory("not-git");
		assert.match((await turn(dir, [workRemote])).stderr, /is zone personal/);
		assert.equal((await turn(dir, [workRemote, { path: dir, zone: "work" }])).passed, true);
	});
});

describe("git failure with real git", () => {
	it("blocks, naming git, when git is missing and a remote rule matters", async () => {
		const dir = repo("git-missing", { origin: "git@github.com:Acme/api.git" });
		const result = await turn(dir, [workRemote], noGit);
		assert.equal(result.passed, false);
		assert.match(
			result.stderr,
			/^BLOCKED acme \(stored-key\): cannot decide this place's zone \(git is not installed or not on PATH\)\. No turn was sent\./,
		);
	});

	it("keeps blocking every turn until the next session start", async () => {
		const dir = repo("git-missing-cached", { origin: "git@github.com:Acme/api.git" });
		const host = createFakeHost();
		let stderr = "";
		let env: NodeJS.ProcessEnv = noGit;
		registerGuard(host.pi as never, {
			home: "/home/me",
			configPath: "/home/me/.pi/agent/account-guard.json",
			readConfigText: () => JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }], places: [workRemote] }),
			realpath: realpathIfPresent,
			readRemoteUrls: (cwd) => readGitRemoteUrls(cwd, env),
			writeStderr: (text) => {
				stderr += text;
			},
			setExitCode: () => {},
		});
		const session = createFakeSession({ cwd: dir });
		await host.fire("session_start", { reason: "startup" }, session.ctx);
		env = process.env;
		assert.deepEqual(await host.fire("input", { text: "a", source: "interactive" }, session.ctx), { action: "handled" });
		assert.deepEqual(await host.fire("input", { text: "b", source: "interactive" }, session.ctx), { action: "handled" });
		await host.fire("session_start", { reason: "reload" }, session.ctx);
		assert.equal(await host.fire("input", { text: "c", source: "interactive" }, session.ctx), undefined);
		assert.equal(stderr.match(/cannot decide this place's zone/g)?.length, 2);
	});

	it("lets a path-only rule that matches first decide when git is missing", async () => {
		const dir = repo("git-missing-path-first", { origin: "git@github.com:Acme/api.git" });
		assert.equal((await turn(dir, [{ path: dir, zone: "work" }, workRemote], noGit)).passed, true);
	});

	it("does not run git at all when no rule has a remote condition", async () => {
		const dir = repo("no-remote-rules");
		assert.match((await turn(dir, [{ path: join(root, "elsewhere"), zone: "work" }], noGit)).stderr, /is zone personal/);
	});

	it("blocks when git cannot read the repository", async () => {
		const dir = repo("corrupt-config", { origin: "git@github.com:Acme/api.git" });
		writeFileSync(join(dir, ".git", "config"), '[remote "origin"\n\turl = =\n');
		const result = await turn(dir, [workRemote]);
		assert.equal(result.passed, false);
		assert.match(result.stderr, /cannot decide this place's zone \(git failed: /);
	});

	it("says the directory is missing, not that git is missing", () => {
		const result = readGitRemoteUrls(join(root, "no-such-directory"));
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.reason, /^the directory .*no-such-directory does not exist$/);
	});

	it("scrubs credentials embedded in a URL from the git error text", async () => {
		const bin = plainDirectory("noisy-git-bin");
		writeFileSync(join(bin, "git"), "#!/bin/sh\necho \"fatal: unable to access 'https://deploy:hunter2@example.com/Acme/api.git/': denied\" >&2\nexit 1\n");
		chmodSync(join(bin, "git"), 0o755);
		const dir = repo("noisy-git", { origin: "git@github.com:Acme/api.git" });
		const result = await turn(dir, [workRemote], { ...process.env, PATH: bin });
		assert.equal(result.passed, false);
		assert.match(result.stderr, /git failed: fatal: unable to access 'https:\/\/example\.com\/Acme\/api\.git\/': denied/);
		assert.doesNotMatch(result.stderr, /hunter2|deploy/);
	});

	it("blocks when git does not answer in time", async () => {
		const bin = plainDirectory("slow-git-bin");
		writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 10\n");
		chmodSync(join(bin, "git"), 0o755);
		const dir = repo("slow-git", { origin: "git@github.com:Acme/api.git" });
		const result = await turn(dir, [workRemote], { ...process.env, PATH: bin });
		assert.equal(result.passed, false);
		assert.match(result.stderr, /cannot decide this place's zone \(git did not answer within 2 s\)/);
	});
});
