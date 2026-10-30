import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ref } from "../../src/core/library.ts";
import { addedConsequence, findPlaced, removalConsequence } from "../../src/core/ref-relations.ts";
import { resolveRefs } from "../../src/core/resolve.ts";
import type { Place } from "../../src/core/scope.ts";

const snippet = (name: string, text: string, scope?: Ref["scope"]): Ref => ({ name, kind: "snippet", text, ...(scope && { scope }) });
const place: Place = { cwd: "/work/app", home: "/home/me", realpath: (path) => path, remotes: () => [] };
const HERE = { path: "/work/app" };
const ELSEWHERE = { path: "/other" };

const layered = (global: Ref[], project: Ref[]) => resolveRefs({ global, project }, place);

describe("findPlaced", () => {
	it("finds a Ref by library and case-insensitive name, Scoped or not", () => {
		const resolved = layered([snippet("S", "1", HERE), snippet("g", "2")], [snippet("p", "3")]);
		assert.equal(findPlaced(resolved, "global", "s")?.layer, "scoped");
		assert.equal(findPlaced(resolved, "global", "G")?.layer, "global");
		assert.equal(findPlaced(resolved, "project", "p")?.layer, "project");
		assert.equal(findPlaced(resolved, "global", "p"), undefined);
	});

	it("does not find a Scoped Ref whose scope does not match here", () => {
		assert.equal(findPlaced(layered([snippet("e", "1", ELSEWHERE)], []), "global", "e"), undefined);
	});
});

describe("addedConsequence", () => {
	it("says nothing when the name is new", () => {
		assert.equal(addedConsequence(layered([snippet("a", "1")], []), "global", "a"), "");
	});

	it("says what the new Ref shadows", () => {
		const resolved = layered([snippet("a", "g", HERE)], [snippet("a", "p")]);
		assert.equal(addedConsequence(resolved, "global", "a"), '; it shadows "a" in the Project library');
	});

	it("says what the new Ref is shadowed by, and that the other one stays in force", () => {
		const resolved = layered([snippet("a", "g")], [snippet("a", "p")]);
		assert.equal(addedConsequence(resolved, "global", "a"), '; it is shadowed by "a" in the Project library, so #a still means that one here');
	});

	it("names the Global layer a Project Ref is shadowed by", () => {
		const resolved = layered([snippet("a", "g", HERE)], [snippet("a", "p")]);
		assert.equal(
			addedConsequence(resolved, "project", "a"),
			'; it is shadowed by "a" in the Global library, scoped to here, so #a still means that one here',
		);
	});

	it("says when the scope does not match here", () => {
		assert.equal(
			addedConsequence(layered([snippet("a", "g", ELSEWHERE)], []), "global", "a"),
			"; its scope does not match here, so it is not Visible here",
		);
	});
});

describe("removalConsequence", () => {
	it("lists the Refs the removed one was shadowing, which become Visible", () => {
		const resolved = layered([snippet("a", "g")], [snippet("a", "p")]);
		const placed = findPlaced(resolved, "project", "a");
		assert.ok(placed);
		assert.equal(removalConsequence(resolved, placed), 'It shadows "a" in the Global library; removing it makes that Ref Visible.');
	});

	it("says a Shadowed Ref's removal changes nothing you can see", () => {
		const resolved = layered([snippet("a", "g")], [snippet("a", "p")]);
		const placed = findPlaced(resolved, "global", "a");
		assert.ok(placed);
		assert.equal(removalConsequence(resolved, placed), 'It is shadowed by "a" in the Project library, so removing it changes nothing you can see.');
	});

	it("names every Ref the removed one was shadowing", () => {
		const resolved = layered([snippet("a", "s", HERE)], [snippet("a", "p")]);
		const placed = findPlaced(resolved, "global", "a");
		assert.ok(placed);
		assert.equal(removalConsequence(resolved, placed), 'It shadows "a" in the Project library; removing it makes that Ref Visible.');
	});

	it("says nothing when it shadows nothing and is not shadowed", () => {
		const resolved = layered([snippet("a", "g")], []);
		const placed = findPlaced(resolved, "global", "a");
		assert.ok(placed);
		assert.equal(removalConsequence(resolved, placed), "");
	});
});
