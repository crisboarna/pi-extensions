import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PathReader, type PlaceRule, type RemoteReader, resolvePlaceZone } from "../../src/core/place.ts";

/** A reader over a fake file system: `links` maps a path to its real path, `existing` lists real directories. */
function reader(links: Record<string, string> = {}, existing: string[] = []): PathReader {
	return {
		home: "/home/me",
		realpath: (path) => links[path] ?? (existing.includes(path) ? path : undefined),
	};
}

const noGit: RemoteReader = () => {
	throw new Error("git must not run for path-only rules");
};

/** Resolves with path-only rules; the zone and the deciding rule, with git forbidden. */
function zoneOf(place: string, rules: PlaceRule[], paths: PathReader = reader()) {
	const { ok, ...resolved } = resolvePlaceZone(place, rules, "personal", paths, noGit);
	assert.ok(ok);
	return resolved as { zone: string; ruleIndex?: number };
}

const resolveWith = (rules: PlaceRule[], remotes: RemoteReader, place = "/srv/app") => resolvePlaceZone(place, rules, "personal", reader(), remotes);
const remotesOf =
	(...urls: string[]): RemoteReader =>
	() => ({ ok: true, urls });
const gitFails: RemoteReader = () => ({ ok: false, reason: "git is not installed or not on PATH" });

describe("resolvePlaceZone", () => {
	it("falls to the default zone when no rule matches", () => {
		assert.deepEqual(zoneOf("/srv/app", [{ path: "/work", zone: "work" }]), { zone: "personal" });
		assert.deepEqual(zoneOf("/srv/app", []), { zone: "personal" });
	});

	it("matches a bare directory and everything below it", () => {
		const rules = [{ path: "/work/co", zone: "work" }];
		assert.deepEqual(zoneOf("/work/co", rules), { zone: "work", ruleIndex: 0 });
		assert.deepEqual(zoneOf("/work/co/deep/er", rules), { zone: "work", ruleIndex: 0 });
	});

	it("does not match a sibling that only shares a name prefix", () => {
		assert.deepEqual(zoneOf("/work/company", [{ path: "/work/co", zone: "work" }]), { zone: "personal" });
	});

	it("expands ~ to the home directory", () => {
		assert.deepEqual(zoneOf("/home/me/Projects/co/api", [{ path: "~/Projects/co", zone: "work" }]), { zone: "work", ruleIndex: 0 });
		assert.deepEqual(zoneOf("/home/me", [{ path: "~", zone: "work" }]), { zone: "work", ruleIndex: 0 });
	});

	it("matches * against one path segment only", () => {
		const rules = [{ path: "/work/*/api", zone: "work" }];
		assert.equal(zoneOf("/work/co/api", rules).zone, "work");
		assert.equal(zoneOf("/work/co/team/api", rules).zone, "personal");
		assert.equal(zoneOf("/work/co/api/sub", rules).zone, "personal", "a glob matches the whole path, not a subtree");
	});

	it("matches ** against any depth, including none", () => {
		const rules = [{ path: "/work/**/api", zone: "work" }];
		assert.equal(zoneOf("/work/api", rules).zone, "work");
		assert.equal(zoneOf("/work/a/b/api", rules).zone, "work");
		assert.equal(zoneOf("/work/a/b/web", rules).zone, "personal");
	});

	it("matches a trailing /** against the directory and everything below", () => {
		const rules = [{ path: "/work/**", zone: "work" }];
		assert.equal(zoneOf("/work", rules).zone, "work");
		assert.equal(zoneOf("/work/a/b", rules).zone, "work");
		assert.equal(zoneOf("/workshop", rules).zone, "personal");
	});

	it("matches {a,b} alternatives and ? as one character", () => {
		const rules = [{ path: "/work/{co,corp}/app?", zone: "work" }];
		assert.equal(zoneOf("/work/co/app1", rules).zone, "work");
		assert.equal(zoneOf("/work/corp/app2", rules).zone, "work");
		assert.equal(zoneOf("/work/inc/app1", rules).zone, "personal");
		assert.equal(zoneOf("/work/co/app12", rules).zone, "personal");
	});

	it("matches case-sensitively", () => {
		assert.equal(zoneOf("/work/Co", [{ path: "/work/co", zone: "work" }]).zone, "personal");
	});

	it("does not treat regex characters in a path as special", () => {
		assert.equal(zoneOf("/work/a.b+c", [{ path: "/work/a.b+c", zone: "work" }]).zone, "work");
		assert.equal(zoneOf("/work/aXb+c", [{ path: "/work/a.b+c", zone: "work" }]).zone, "personal");
	});

	it("resolves a symlinked rule path to its real path when it exists", () => {
		const paths = reader({ "/home/me/link": "/data/real" });
		assert.equal(zoneOf("/data/real/app", [{ path: "~/link", zone: "work" }], paths).zone, "work");
		assert.equal(zoneOf("/home/me/link/app", [{ path: "~/link", zone: "work" }], paths).zone, "personal", "only the real path of the place is matched");
	});

	it("resolves the existing leading directory of a glob rule path", () => {
		const paths = reader({ "/home/me/link": "/data/real" });
		assert.equal(zoneOf("/data/real/a/b", [{ path: "~/link/**", zone: "work" }], paths).zone, "work");
	});

	it("matches a rule path that does not exist yet as the literal path", () => {
		assert.equal(zoneOf("/future/dir/sub", [{ path: "/future/dir", zone: "work" }]).zone, "work");
	});

	it("lets the first matching rule win, in file order", () => {
		const rules = [
			{ path: "/work/co/personal-fork", zone: "personal" },
			{ path: "/work/co", zone: "work" },
			{ path: "/work", zone: "other" },
		];
		assert.deepEqual(zoneOf("/work/co/personal-fork/x", rules), { zone: "personal", ruleIndex: 0 });
		assert.deepEqual(zoneOf("/work/co/api", rules), { zone: "work", ruleIndex: 1 });
		assert.deepEqual(zoneOf("/work/elsewhere", rules), { zone: "other", ruleIndex: 2 });
	});
});

describe("resolvePlaceZone with remote conditions", () => {
	it("matches a remote-only rule against any remote of the place", () => {
		const rules = [{ remote: "*/Acme/*", zone: "work" }];
		assert.deepEqual(resolveWith(rules, remotesOf("git@github.com:Acme/api.git")), { ok: true, zone: "work", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rules, remotesOf("https://github.com/me/fork.git", "git@github.com:Acme/api.git")), {
			ok: true,
			zone: "work",
			ruleIndex: 0,
		});
		assert.deepEqual(resolveWith(rules, remotesOf("https://github.com/me/fork.git")), { ok: true, zone: "personal" });
	});

	it("matches the ssh and https forms of one repository with the same rule", () => {
		const rules = [{ remote: "github.com/Acme/api", zone: "work" }];
		for (const url of [
			"git@github.com:Acme/api.git",
			"ssh://git@github.com/Acme/api.git",
			"https://github.com/Acme/api.git",
			"https://user:secret@github.com/Acme/api",
		]) {
			assert.deepEqual(resolveWith(rules, remotesOf(url)), { ok: true, zone: "work", ruleIndex: 0 }, url);
		}
	});

	it("matches remotes case-insensitively", () => {
		assert.deepEqual(resolveWith([{ remote: "*/acme/*", zone: "work" }], remotesOf("git@GitHub.com:ACME/Api.git")), {
			ok: true,
			zone: "work",
			ruleIndex: 0,
		});
	});

	it("matches * against one segment and ** against any depth", () => {
		const one = resolveWith([{ remote: "gitlab.com/acme/*", zone: "work" }], remotesOf("https://gitlab.com/acme/team/api.git"));
		assert.deepEqual(one, { ok: true, zone: "personal" });
		const deep = resolveWith([{ remote: "gitlab.com/acme/**", zone: "work" }], remotesOf("https://gitlab.com/acme/team/api.git"));
		assert.deepEqual(deep, { ok: true, zone: "work", ruleIndex: 0 });
	});

	it("matches a leading ** against any depth, including none", () => {
		const rule = [{ remote: "**/acme-corp/*", zone: "work" }];
		assert.deepEqual(resolveWith(rule, remotesOf("git@github.com:acme-corp/api.git")), { ok: true, zone: "work", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rule, remotesOf("https://git.example.com/group/acme-corp/api.git")), { ok: true, zone: "work", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rule, remotesOf("https://git.example.com/group/other/api.git")), { ok: true, zone: "personal" });
	});

	it("matches a leading ** inside a brace alternative against any depth", () => {
		const rule = [{ remote: "{**/acme-corp/*,nowhere/*}", zone: "work" }];
		assert.deepEqual(resolveWith(rule, remotesOf("https://git.example.com/group/acme-corp/api.git")), { ok: true, zone: "work", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rule, remotesOf("https://git.example.com/group/other/api.git")), { ok: true, zone: "personal" });
	});

	it("keeps ** after other text in a segment as a single-segment wildcard", () => {
		const rule = [{ remote: "gitlab.com/ac**/api", zone: "work" }];
		assert.deepEqual(resolveWith(rule, remotesOf("https://gitlab.com/acme/api.git")), { ok: true, zone: "work", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rule, remotesOf("https://gitlab.com/acme/team/api.git")), { ok: true, zone: "personal" });
	});

	it("answers a pattern that would backtrack badly in linear time", () => {
		const subject = "a".repeat(120);
		const rules = [
			{ remote: "*a*a*a*a*a*a*b", zone: "work" },
			{ remote: "**/**/**/**/**/**/**/x", zone: "work" },
			{ remote: "{a*,a*}{a*,a*}{a*,a*}*b", zone: "work" },
		];
		const started = Date.now();
		assert.deepEqual(resolveWith(rules, remotesOf(subject)), { ok: true, zone: "personal" });
		assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
	});

	it("requires both conditions of a combined rule", () => {
		const rules = [{ path: "/srv", remote: "*/Acme/*", zone: "work" }];
		const acme = remotesOf("git@github.com:Acme/api.git");
		assert.deepEqual(resolveWith(rules, acme, "/srv/app"), { ok: true, zone: "work", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rules, acme, "/elsewhere/app"), { ok: true, zone: "personal" });
		assert.deepEqual(resolveWith(rules, remotesOf("git@github.com:me/api.git"), "/srv/app"), { ok: true, zone: "personal" });
	});

	it("lets the first matching rule win across rule kinds", () => {
		const rules = [
			{ path: "/srv", remote: "*/me/*", zone: "personal" },
			{ path: "/srv", zone: "work" },
			{ remote: "*/Acme/*", zone: "other" },
		];
		assert.deepEqual(resolveWith(rules, remotesOf("git@github.com:me/site.git")), { ok: true, zone: "personal", ruleIndex: 0 });
		assert.deepEqual(resolveWith(rules, remotesOf("git@github.com:Acme/api.git")), { ok: true, zone: "work", ruleIndex: 1 });
		assert.deepEqual(resolveWith(rules, remotesOf("git@github.com:Acme/api.git"), "/elsewhere"), { ok: true, zone: "other", ruleIndex: 2 });
	});

	it("does not match remote rules for a place without remotes, while path rules still apply", () => {
		const rules = [
			{ remote: "*/Acme/*", zone: "work" },
			{ path: "/srv", zone: "other" },
		];
		assert.deepEqual(resolveWith(rules, remotesOf()), { ok: true, zone: "other", ruleIndex: 1 });
		assert.deepEqual(resolveWith([rules[0]!], remotesOf()), { ok: true, zone: "personal" });
	});

	it("is undecidable when git fails and a rule with a remote condition applies", () => {
		assert.deepEqual(resolveWith([{ remote: "*/Acme/*", zone: "work" }], gitFails), { ok: false, reason: "git is not installed or not on PATH" });
		const combined = [{ path: "/srv", remote: "*/Acme/*", zone: "work" }];
		assert.equal(resolveWith(combined, gitFails).ok, false);
	});

	it("lets a path-only rule that matches before any remote rule decide when git fails", () => {
		const rules = [
			{ path: "/srv", zone: "work" },
			{ remote: "*/Acme/*", zone: "other" },
		];
		assert.deepEqual(resolveWith(rules, gitFails), { ok: true, zone: "work", ruleIndex: 0 });
	});

	it("does not need git for a combined rule whose path misses", () => {
		const rules = [{ path: "/other", remote: "*/Acme/*", zone: "work" }];
		assert.deepEqual(resolveWith(rules, noGit), { ok: true, zone: "personal" });
	});

	it("is undecidable when git fails before a later path-only rule could decide", () => {
		const rules = [
			{ remote: "*/Acme/*", zone: "other" },
			{ path: "/srv", zone: "work" },
		];
		assert.equal(resolveWith(rules, gitFails).ok, false);
	});

	it("reads the remotes at most once per resolution", () => {
		let reads = 0;
		const counting: RemoteReader = () => {
			reads++;
			return { ok: true, urls: ["git@github.com:me/x.git"] };
		};
		resolveWith(
			[
				{ remote: "*/a/*", zone: "work" },
				{ remote: "*/b/*", zone: "work" },
			],
			counting,
		);
		assert.equal(reads, 1);
	});
});
