import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { type Layer, resolveRefs, visibleRefs } from "../../src/core/resolve.ts";
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

describe("visibleRefs", () => {
	it("keeps the first Ref of a name, compared case-insensitively", () => {
		const visible = visibleRefs([snippet("Api", "first"), snippet("api", "second")]);
		assert.equal(visible.size, 1);
		assert.deepEqual(visible.get("api"), snippet("Api", "first"));
	});
});
