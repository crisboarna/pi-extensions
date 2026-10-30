import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { bundleMembers, type Layer, resolveRefs, visibleRefs } from "../../src/core/resolve.ts";
import type { Place } from "../../src/core/scope.ts";

const snippet = (name: string, text: string, scope?: Ref["scope"]): Ref => ({ name, kind: "snippet", text, ...(scope && { scope }) });

const place = (cwd = "/work/app", remotes: string[] = ["https://github.com/acme/app.git"]): Place => ({
	cwd,
	home: "/home/me",
	realpath: (path) => path,
	remotes: () => remotes,
});

const HERE = { path: "/work/app" };
const ELSEWHERE = { path: "/other" };

/** The layer and text that win for `name`. */
function winner(sources: Parameters<typeof resolveRefs>[0], name: string, at = place()) {
	const layered = resolveRefs(sources, at);
	const ref = layered.visible.get(name);
	return ref && { layer: layered.layers.get(name), text: ref.kind === "snippet" ? ref.text : undefined };
}

describe("resolveRefs: precedence", () => {
	const table: Array<{ name: string; sources: Parameters<typeof resolveRefs>[0]; wins: Layer; text: string; shadowedLayers: Layer[] }> = [
		{
			name: "the Project library beats an unscoped Global Ref and a Built-in Ref",
			sources: {
				global: [snippet("t", "global")],
				project: [snippet("t", "project")],
				builtin: [snippet("t", "builtin")],
			},
			wins: "project",
			text: "project",
			shadowedLayers: ["global", "builtin"],
		},
		{
			name: "scoped over project over global over built-in",
			sources: {
				global: [snippet("t", "scoped", HERE)],
				project: [snippet("t", "project")],
				builtin: [snippet("t", "builtin")],
			},
			wins: "scoped",
			text: "scoped",
			shadowedLayers: ["project", "builtin"],
		},
		{
			name: "the Project library beats an unscoped Global Ref",
			sources: { global: [snippet("t", "global")], project: [snippet("t", "project")] },
			wins: "project",
			text: "project",
			shadowedLayers: ["global"],
		},
		{
			name: "an unscoped Global Ref beats a Built-in Ref",
			sources: { global: [snippet("t", "global")], project: [], builtin: [snippet("t", "builtin")] },
			wins: "global",
			text: "global",
			shadowedLayers: ["builtin"],
		},
		{
			name: "a Built-in Ref wins when it is alone",
			sources: { global: [], project: [], builtin: [snippet("t", "builtin")] },
			wins: "builtin",
			text: "builtin",
			shadowedLayers: [],
		},
		{
			name: "a Scoped Ref whose scope does not match is not Visible and shadows nothing",
			sources: { global: [snippet("t", "elsewhere", ELSEWHERE), snippet("u", "global")], project: [snippet("t", "project")] },
			wins: "project",
			text: "project",
			shadowedLayers: [],
		},
	];
	for (const row of table) {
		it(row.name, () => {
			const layered = resolveRefs(row.sources, place());
			assert.deepEqual(winner(row.sources, "t"), { layer: row.wins, text: row.text });
			assert.deepEqual(
				layered.shadowed.filter((entry) => entry.ref.name === "t").map((entry) => entry.layer),
				row.shadowedLayers,
			);
		});
	}

	it("names the Visible Ref that shadows each Shadowed Ref", () => {
		const layered = resolveRefs({ global: [snippet("t", "global")], project: [snippet("t", "project")] }, place());
		assert.deepEqual(layered.shadowed, [{ ref: snippet("t", "global"), layer: "global", by: { ref: snippet("t", "project"), layer: "project" } }]);
	});

	it("compares names case-insensitively across layers", () => {
		const layered = resolveRefs({ global: [snippet("API", "global")], project: [snippet("api", "project")] }, place());
		assert.equal(layered.visible.size, 1);
		assert.equal(layered.layers.get("api"), "project");
		assert.equal(layered.shadowed.length, 1);
	});

	it("takes the first Ref of a name inside one layer and shadows the later ones", () => {
		const first = snippet("t", "first", HERE);
		const second = snippet("t", "second", { remote: "github.com/acme/app" });
		const layered = resolveRefs({ global: [first, second], project: [] }, place());
		assert.deepEqual(layered.visible.get("t"), first);
		assert.deepEqual(
			layered.shadowed.map((entry) => entry.ref),
			[second],
		);
	});

	it("lists the Refs that apply here in precedence order, and the Scoped Refs that apply elsewhere", () => {
		const layered = resolveRefs(
			{
				global: [snippet("g", "1"), snippet("s", "2", HERE), snippet("e", "3", ELSEWHERE)],
				project: [snippet("p", "4")],
				builtin: [snippet("b", "5")],
			},
			place(),
		);
		assert.deepEqual(
			layered.applicable.map((entry) => `${entry.layer}:${entry.ref.name}`),
			["scoped:s", "project:p", "global:g", "builtin:b"],
		);
		assert.deepEqual(
			layered.scopedElsewhere.map((ref) => ref.name),
			["e"],
		);
	});

	it("asks git once for however many Scoped Refs have a remote", () => {
		let calls = 0;
		const counting: Place = {
			...place(),
			remotes: () => {
				calls += 1;
				return ["https://github.com/acme/app.git"];
			},
		};
		const remote = { remote: "github.com/acme/app" };
		const layered = resolveRefs(
			{ global: [snippet("a", "1", remote), snippet("b", "2", remote), snippet("c", "3", { remote: "x/y" })], project: [] },
			counting,
		);
		assert.equal(calls, 1);
		assert.deepEqual([...layered.visible.keys()], ["a", "b"]);
	});

	it("hides a remote-scoped Ref when git fails", () => {
		const failing: Place = { ...place(), remotes: () => undefined };
		const layered = resolveRefs({ global: [snippet("a", "1", { remote: "github.com/acme/app" })], project: [] }, failing);
		assert.equal(layered.visible.size, 0);
		assert.equal(layered.scopedElsewhere.length, 1);
	});
});

const member = (name: string, tags?: string[]): Ref => ({ name, kind: "snippet", text: name, ...(tags ? { tags } : {}) });
const names = (refs: Ref[]): string[] => refs.map((ref) => ref.name);

describe("bundleMembers", () => {
	it("is every Visible Ref that carries the Tag, in file order", () => {
		const visible = visibleRefs([member("c", ["docs"]), member("a", ["docs", "ops"]), member("b", ["ops"]), member("d")]);
		assert.deepEqual(names(bundleMembers(visible, "docs")), ["c", "a"]);
		assert.deepEqual(names(bundleMembers(visible, "ops")), ["a", "b"]);
	});

	it("compares tags without regard to case, on both sides", () => {
		const visible = visibleRefs([member("a", ["Docs"]), member("b", ["DOCS"]), member("c", ["other"])]);
		assert.deepEqual(names(bundleMembers(visible, "dOcS")), ["a", "b"]);
	});

	it("is empty for a Tag no Visible Ref carries, and for Refs without tags", () => {
		const visible = visibleRefs([member("a", ["docs"]), member("b")]);
		assert.deepEqual(bundleMembers(visible, "nope"), []);
		assert.deepEqual(bundleMembers(visibleRefs([member("b")]), "docs"), []);
	});

	it("lists a Ref once, however often it repeats a Tag", () => {
		assert.deepEqual(names(bundleMembers(visibleRefs([member("a", ["x", "X", "x"])]), "x")), ["a"]);
	});

	it("leaves out a Ref that another Ref of the same name shadows, and a Scoped Ref until its scope matches", () => {
		const scoped: Ref = { ...member("a", ["docs"]), scope: { path: "/work/*" } };
		const visible = visibleRefs([scoped, member("a", ["docs"]), member("b", ["docs"])]);
		assert.deepEqual(names(bundleMembers(visible, "docs")), ["a", "b"]);
		assert.equal(bundleMembers(visible, "docs")[0]?.scope, undefined);
	});

	it("follows the order of the Visible Refs, which are built scoped, project, global, then file order", () => {
		const scoped = member("scoped", ["t"]);
		const project = member("project", ["t"]);
		const global1 = member("global-1", ["t"]);
		const global2 = member("global-2", ["t"]);
		const visible = new Map([scoped, project, global1, global2].map((ref) => [ref.name, ref]));
		assert.deepEqual(names(bundleMembers(visible, "t")), ["scoped", "project", "global-1", "global-2"]);
	});
});
