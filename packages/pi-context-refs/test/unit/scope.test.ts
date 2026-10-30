import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRemote, type Place, scopeMatches } from "../../src/core/scope.ts";

const HOME = "/home/me";

/** A place with the given working directory and remotes; `real` maps a path to its real path (a symlink). */
function place(cwd: string, remotes: string[] | "git fails" = [], real: Record<string, string> = {}): Place & { gitCalls: number } {
	const fake = {
		cwd,
		home: HOME,
		gitCalls: 0,
		realpath: (path: string) => real[path] ?? (path.startsWith("/missing") ? undefined : path),
		remotes: () => {
			fake.gitCalls += 1;
			return remotes === "git fails" ? undefined : remotes;
		},
	};
	return fake;
}

describe("normalizeRemote", () => {
	const table: Array<[string, string]> = [
		["https://github.com/Acme/App.git", "github.com/acme/app"],
		["git@github.com:acme/app.git", "github.com/acme/app"],
		["ssh://git@github.com:22/acme/app", "github.com/acme/app"],
		["ssh://git@github.com/acme/app/", "github.com/acme/app"],
		["https://user:secret@gitlab.example.com/group/sub/app.git", "gitlab.example.com/group/sub/app"],
		["github.com/acme/app", "github.com/acme/app"],
		["GitHub.com/Acme/App", "github.com/acme/app"],
		["  https://github.com//acme//app.git  ", "github.com/acme/app"],
	];
	for (const [url, expected] of table) {
		it(`reads ${url} as ${expected}`, () => assert.equal(normalizeRemote(url), expected));
	}
});

describe("scopeMatches: path", () => {
	const table: Array<[string, string, string, boolean]> = [
		["a bare directory matches itself", "/work/app", "/work/app", true],
		["a bare directory matches its subtree", "/work/app", "/work/app/src/deep", true],
		["a trailing slash does not matter", "/work/app/", "/work/app", true],
		["a sibling with the same prefix does not match", "/work/app", "/work/app-two", false],
		["a parent does not match", "/work/app", "/work", false],
		["~ expands to the home directory", "~/work", "/home/me/work/app", true],
		["a relative directory resolves against the working directory", ".", "/work/app", true],
		["* is one segment", "/work/*", "/work/app", true],
		["* does not cross a slash", "/work/*", "/work/app/src", false],
		["/** is the directory and everything below it", "/work/**", "/work", true],
		["/** reaches any depth", "/work/**", "/work/a/b/c", true],
		["**/ spans any number of leading segments", "**/app", "/work/deep/app", true],
		["? is one character", "/work/ap?", "/work/app", true],
		["? does not match a slash", "/work/ap?", "/work/ap/", false],
		["{a,b} alternatives", "/work/{app,lib}", "/work/lib", true],
		["{a,b} alternatives that do not match", "/work/{app,lib}", "/work/other", false],
		["a regex character in a glob is literal", "/work/a.c*", "/work/abc1", false],
		["a regex character in a glob is literal (match)", "/work/a.c*", "/work/a.c1", true],
	];
	for (const [name, scope, cwd, expected] of table) {
		it(name, () => assert.equal(scopeMatches({ path: scope }, place(cwd)), expected));
	}

	it("compares real paths, so a symlinked working directory matches the directory it points to", () => {
		assert.equal(scopeMatches({ path: "/work/app" }, place("/link", [], { "/link": "/work/app" })), true);
		assert.equal(scopeMatches({ path: "/link" }, place("/work/app", [], { "/link": "/work/app" })), true);
	});

	it("never asks git for a path-only scope", () => {
		const here = place("/work/app");
		scopeMatches({ path: "/work/app" }, here);
		assert.equal(here.gitCalls, 0);
	});
});

describe("scopeMatches: remote", () => {
	const origins = ["https://github.com/acme/app.git"];

	it("matches any remote of the repository, normalized to host/path, case-insensitively", () => {
		assert.equal(scopeMatches({ remote: "github.com/acme/app" }, place("/w", origins)), true);
		assert.equal(scopeMatches({ remote: "GitHub.com/ACME/App" }, place("/w", origins)), true);
		assert.equal(scopeMatches({ remote: "github.com/acme/app" }, place("/w", ["git@gitlab.com:x/y.git", "git@github.com:acme/app.git"])), true);
	});

	it("accepts the scope written as a URL", () => {
		assert.equal(scopeMatches({ remote: "git@github.com:acme/app.git" }, place("/w", origins)), true);
	});

	it("does not match another repository, or a longer path", () => {
		assert.equal(scopeMatches({ remote: "github.com/acme/other" }, place("/w", origins)), false);
		assert.equal(scopeMatches({ remote: "github.com/acme" }, place("/w", origins)), false);
	});

	it("does not match a repository with no remote", () => {
		assert.equal(scopeMatches({ remote: "github.com/acme/app" }, place("/w", [])), false);
	});

	it("does not match when git fails", () => {
		assert.equal(scopeMatches({ remote: "github.com/acme/app" }, place("/w", "git fails")), false);
	});
});

describe("scopeMatches: path and remote together", () => {
	const origins = ["https://github.com/acme/app.git"];
	const scope = { path: "/work", remote: "github.com/acme/app" };

	it("needs both to match", () => {
		assert.equal(scopeMatches(scope, place("/work/app", origins)), true);
		assert.equal(scopeMatches(scope, place("/elsewhere", origins)), false);
		assert.equal(scopeMatches(scope, place("/work/app", [])), false);
		assert.equal(scopeMatches(scope, place("/work/app", "git fails")), false);
	});

	it("does not ask git when the path already fails", () => {
		const here = place("/elsewhere", origins);
		scopeMatches(scope, here);
		assert.equal(here.gitCalls, 0);
	});
});
