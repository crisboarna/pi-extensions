import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { bundleMembers, visibleRefs } from "../../src/core/resolve.ts";

const snippet = (name: string, tags?: string[]): Ref => ({ name, kind: "snippet", text: name, ...(tags ? { tags } : {}) });
const names = (refs: Ref[]): string[] => refs.map((ref) => ref.name);

describe("bundleMembers", () => {
	it("is every Visible Ref that carries the Tag, in file order", () => {
		const visible = visibleRefs([snippet("c", ["docs"]), snippet("a", ["docs", "ops"]), snippet("b", ["ops"]), snippet("d")]);
		assert.deepEqual(names(bundleMembers(visible, "docs")), ["c", "a"]);
		assert.deepEqual(names(bundleMembers(visible, "ops")), ["a", "b"]);
	});

	it("compares tags without regard to case, on both sides", () => {
		const visible = visibleRefs([snippet("a", ["Docs"]), snippet("b", ["DOCS"]), snippet("c", ["other"])]);
		assert.deepEqual(names(bundleMembers(visible, "dOcS")), ["a", "b"]);
	});

	it("is empty for a Tag no Visible Ref carries, and for Refs without tags", () => {
		const visible = visibleRefs([snippet("a", ["docs"]), snippet("b")]);
		assert.deepEqual(bundleMembers(visible, "nope"), []);
		assert.deepEqual(bundleMembers(visibleRefs([snippet("b")]), "docs"), []);
	});

	it("lists a Ref once, however often it repeats a Tag", () => {
		assert.deepEqual(names(bundleMembers(visibleRefs([snippet("a", ["x", "X", "x"])]), "x")), ["a"]);
	});

	it("leaves out a Ref that another Ref of the same name shadows, and a Scoped Ref until its scope matches", () => {
		const scoped: Ref = { ...snippet("a", ["docs"]), scope: { path: "/work/*" } };
		const visible = visibleRefs([scoped, snippet("a", ["docs"]), snippet("b", ["docs"])]);
		assert.deepEqual(names(bundleMembers(visible, "docs")), ["a", "b"]);
		assert.equal(bundleMembers(visible, "docs")[0]?.scope, undefined);
	});

	it("follows the order of the Visible Refs, which are built scoped, project, global, then file order", () => {
		const scoped = snippet("scoped", ["t"]);
		const project = snippet("project", ["t"]);
		const global1 = snippet("global-1", ["t"]);
		const global2 = snippet("global-2", ["t"]);
		const visible = new Map([scoped, project, global1, global2].map((ref) => [ref.name, ref]));
		assert.deepEqual(names(bundleMembers(visible, "t")), ["scoped", "project", "global-1", "global-2"]);
	});
});
