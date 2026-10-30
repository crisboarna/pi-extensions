import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandRefs } from "../../src/core/expand.ts";
import type { Ref } from "../../src/core/library.ts";
import { visibleRefs } from "../../src/core/resolve.ts";

const ENV = { cwd: "/work/repo", home: "/home/me" };
const snippet = (name: string, text: string): Ref => ({ name, kind: "snippet", text });
const path = (name: string, target: string): Ref => ({ name, kind: "path", path: target });
const expand = (text: string, refs: Ref[]): string => expandRefs(text, visibleRefs(refs), ENV);

describe("Snippet", () => {
	const refs = [snippet("terse", "Be brief."), snippet("loop", "see #terse and [ref:terse]")];

	it("replaces a typed #name and a Placeholder by its saved text", () => {
		assert.equal(expand("please #terse", refs), "please Be brief.");
		assert.equal(expand("please [ref:terse]", refs), "please Be brief.");
	});

	it("is sent literally, never scanned again for more refs", () => {
		assert.equal(expand("go #loop", refs), "go see #terse and [ref:terse]");
	});

	it("expands at every occurrence", () => {
		assert.equal(expand("#terse #terse", refs), "Be brief. Be brief.");
	});

	it("keeps multi-line text and replacement markers as written", () => {
		assert.equal(expand("a #x b", [snippet("x", "line1\nline2 $& $1 $$")]), "a line1\nline2 $& $1 $$ b");
	});

	it("leaves the punctuation after a typed token in place", () => {
		assert.equal(expand("be #terse, then #terse.", refs), "be Be brief., then Be brief..");
	});
});

describe("Path", () => {
	it("prints a path inside the working directory relative to it", () => {
		assert.equal(expand("see #a", [path("a", "src/api.ts")]), "see src/api.ts");
		assert.equal(expand("see #a", [path("a", "./src/../src/api.ts")]), "see src/api.ts");
		assert.equal(expand("see #a", [path("a", "/work/repo/src/api.ts")]), "see src/api.ts");
	});

	it("prints the working directory itself as a dot", () => {
		assert.equal(expand("in #a", [path("a", ".")]), "in .");
		assert.equal(expand("in #a", [path("a", "/work/repo")]), "in .");
	});

	it("prints a path outside the working directory in full", () => {
		assert.equal(expand("see #a", [path("a", "/etc/hosts")]), "see /etc/hosts");
		assert.equal(expand("see #a", [path("a", "../other/x.md")]), "see /work/other/x.md");
		assert.equal(expand("see #a", [path("a", "/work/repo-other/x")]), "see /work/repo-other/x");
	});

	it("expands ~ to the home directory", () => {
		assert.equal(expand("see #a", [path("a", "~/notes/todo.md")]), "see /home/me/notes/todo.md");
		assert.equal(expand("see #a", [path("a", "~")]), "see /home/me");
	});

	it("prints a path inside the working directory relative even when it was written with ~", () => {
		assert.equal(expand("see #a", [path("a", "~/../../work/repo/src")]), "see src");
	});

	it("treats a name that merely starts with two dots as inside the working directory", () => {
		assert.equal(expand("see #a", [path("a", "..cache/x")]), "see ..cache/x");
	});

	it("does not check that the path exists", () => {
		assert.equal(expand("create #a", [path("a", "not/yet/there.ts")]), "create not/yet/there.ts");
	});

	it("keeps a ~name path that is not the home directory as a relative path", () => {
		assert.equal(expand("see #a", [path("a", "~other/x")]), "see ~other/x");
	});
});

describe("what does not expand", () => {
	const refs = [snippet("terse", "Be brief."), path("agents", "AGENTS.md")];

	it("passes through a name that matches no Ref", () => {
		const text = "#1 priority, issue #42, #unknown, # heading, [ref:unknown]";
		assert.equal(expand(text, refs), text);
	});

	it("matches the whole name only", () => {
		assert.equal(expand("#ters #terse2 #terse-x", refs), "#ters #terse2 #terse-x");
	});

	it("matches case-insensitively", () => {
		assert.equal(expand("#TERSE [ref:Agents]", refs), "Be brief. AGENTS.md");
	});

	it("leaves File and Dynamic refs as typed", () => {
		const others: Ref[] = [
			{ name: "api", kind: "file", path: "src/api.ts" },
			{ name: "diff", kind: "dynamic", command: ["git", "diff"] },
		];
		assert.equal(expand("#api and [ref:diff]", others), "#api and [ref:diff]");
	});

	it("leaves a Scoped Ref as typed until its scope is matched", () => {
		const scoped: Ref = { name: "here", kind: "snippet", text: "x", scope: { path: "/work/repo" } };
		assert.equal(expand("#here", [scoped]), "#here");
	});

	it("returns text with no ref tokens unchanged", () => {
		assert.equal(expand("plain words", refs), "plain words");
	});
});

describe("Bundle", () => {
	const tagged = (ref: Ref, ...tags: string[]): Ref => ({ ...ref, tags });
	const refs = [
		tagged(snippet("terse", "Be brief."), "style"),
		tagged(path("agents", "AGENTS.md"), "docs", "Style"),
		tagged(path("readme", "README.md"), "docs"),
		snippet("loose", "Untagged."),
	];

	it("expands #tag:<tag> to every member, each as it would be on its own, in order", () => {
		assert.equal(expand("read #tag:docs now", refs), "read AGENTS.md README.md now");
		assert.equal(expand("#tag:style", refs), "Be brief. AGENTS.md");
	});

	it("matches the tag case-insensitively, as a typed token", () => {
		assert.equal(expand("#TAG:DOCS", refs), "AGENTS.md README.md");
	});

	it("ends the token like a name, so the sentence can go on", () => {
		assert.equal(expand("read #tag:docs, then #tag:style.", refs), "read AGENTS.md README.md, then Be brief..");
	});

	it("passes an unknown tag through unchanged", () => {
		assert.equal(expand("see #tag:nope and #tag:", refs), "see #tag:nope and #tag:");
	});

	it("leaves a [ref:tag:<tag>] Placeholder alone, because only a typed token is a Bundle", () => {
		assert.equal(expand("[ref:tag:docs]", refs), "[ref:tag:docs]");
	});

	it("does not repeat a member that the message already names, wherever it sits", () => {
		assert.equal(expand("#tag:docs #agents", refs), "README.md AGENTS.md");
		assert.equal(expand("#agents #tag:docs", refs), "AGENTS.md README.md");
		assert.equal(expand("[ref:readme] #tag:docs", refs), "README.md AGENTS.md");
	});

	it("does not repeat a member that an earlier Bundle gave", () => {
		assert.equal(expand("#tag:style then #tag:docs", refs), "Be brief. AGENTS.md then README.md");
	});

	it("drops a Bundle that has nothing left to add, with the space before it", () => {
		assert.equal(expand("#tag:docs and #tag:docs", refs), "AGENTS.md README.md and");
		assert.equal(expand("#agents #readme #tag:docs", refs), "AGENTS.md README.md");
		assert.equal(expand("#tag:docs\n#tag:docs", refs), "AGENTS.md README.md\n");
	});

	it("still expands a member named twice outside the Bundle at every occurrence", () => {
		assert.equal(expand("#terse #terse #tag:style", refs), "Be brief. Be brief. AGENTS.md");
	});

	it("leaves a Ref named tag to the plain #name rule", () => {
		assert.equal(expand("#tag", [snippet("tag", "T")]), "T");
	});

	it("keeps a File or Dynamic member as a Placeholder, to be expanded as a Context block", () => {
		const members = [
			tagged({ name: "api", kind: "file", path: "src/api.ts" }, "ctx"),
			tagged(snippet("terse", "Be brief."), "ctx"),
			tagged({ name: "diff", kind: "dynamic", command: ["git", "diff"] }, "ctx"),
		];
		assert.equal(expand("#tag:ctx", members), "[ref:api] Be brief. [ref:diff]");
	});

	it("does not expand the text of a Snippet member again", () => {
		const members = [tagged(snippet("a", "see #b and #tag:t"), "t"), tagged(snippet("b", "B"), "t")];
		assert.equal(expand("#tag:t", members), "see #b and #tag:t B");
	});

	it("leaves a Scoped Ref out of the Bundle until its scope is matched", () => {
		const scoped: Ref = { ...tagged(snippet("here", "x"), "t"), scope: { path: "/work/repo" } };
		assert.equal(expand("#tag:t", [scoped, tagged(snippet("b", "B"), "t")]), "B");
		assert.equal(expand("#tag:t", [scoped]), "#tag:t");
	});
});

describe("visibleRefs", () => {
	it("keeps the first Ref of a name, compared case-insensitively", () => {
		const visible = visibleRefs([snippet("Api", "first"), snippet("api", "second")]);
		assert.equal(visible.size, 1);
		assert.deepEqual(visible.get("api"), snippet("Api", "first"));
	});
});
