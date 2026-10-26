import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePlaceZone, type PathReader, type PlaceRule } from "../../src/core/place.ts";

/** A reader over a fake file system: `links` maps a path to its real path, `existing` lists real directories. */
function reader(links: Record<string, string> = {}, existing: string[] = []): PathReader {
	return {
		home: "/home/me",
		realpath: (path) => links[path] ?? (existing.includes(path) ? path : undefined),
	};
}

const zoneOf = (place: string, rules: PlaceRule[], paths: PathReader = reader()) => resolvePlaceZone(place, rules, "personal", paths);

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
