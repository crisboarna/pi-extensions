import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { git, initRepo, withoutRepositoryVariables } from "../support/git-repo.ts";

describe("the test git helper under a git hook", () => {
	let dir: string;
	let saved: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "context-refs-git-env-"));
		saved = process.env.GIT_DIR;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	it("drops the variables that point git at one repository and keeps the rest", () => {
		const env = withoutRepositoryVariables({
			GIT_DIR: "/x",
			GIT_WORK_TREE: "/x",
			GIT_INDEX_FILE: "/x",
			GIT_COMMON_DIR: "/x",
			GIT_CONFIG_GLOBAL: "/dev/null",
			PATH: "/bin",
		});
		assert.deepEqual(env, { GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/bin" });
	});

	it("makes a repository in its own directory when a hook has set GIT_DIR", () => {
		const elsewhere = join(dir, "elsewhere.git");
		process.env.GIT_DIR = elsewhere;
		const repository = join(dir, "repo");
		initRepo(repository);
		assert.ok(existsSync(join(repository, ".git")), "the repository is in its own directory");
		assert.equal(existsSync(elsewhere), false, "nothing was made where GIT_DIR points");
		assert.equal(git(repository, "rev-parse", "--is-inside-work-tree").trim(), "true");
	});
});
