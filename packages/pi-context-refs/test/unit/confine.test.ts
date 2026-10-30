import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confinementProblem } from "../../src/core/confine.ts";
import type { Ref } from "../../src/core/library.ts";
import { parseLibrary } from "../../src/core/library.ts";

/** A file system where `links` maps a path to the real path it points to; a path under `/missing` does not exist. */
function files(links: Record<string, string> = {}) {
	const realpath = (path: string): string | undefined => {
		if (path.startsWith("/missing")) return undefined;
		for (const [link, target] of Object.entries(links)) {
			if (path === link) return target;
			if (path.startsWith(`${link}/`)) return target + path.slice(link.length);
		}
		return path;
	};
	return { cwd: "/work/app", home: "/home/me", realpath };
}

const problem = (ref: Ref, links?: Record<string, string>) => confinementProblem(ref, files(links));

describe("confinementProblem", () => {
	it("accepts Path and File targets inside the project", () => {
		assert.equal(problem({ name: "a", kind: "path", path: "src/a.ts" }), undefined);
		assert.equal(problem({ name: "a", kind: "file", path: "./README.md" }), undefined);
		assert.equal(problem({ name: "a", kind: "file", path: "/work/app/docs/../src/a.ts" }), undefined);
		assert.equal(problem({ name: "a", kind: "path", path: "." }), undefined);
	});

	it("accepts a target that does not exist yet, judging it by the nearest directory that does", () => {
		assert.equal(problem({ name: "a", kind: "path", path: "new/dir/file.ts" }), undefined);
	});

	it("rejects a target outside the project, however it is written", () => {
		const outside = ["../secret", "/etc/passwd", "~/.ssh/id_ed25519", "src/../../other/x", "/work/app-two/x", "/work"];
		for (const path of outside) {
			const found = problem({ name: "a", kind: "file", path });
			assert.equal(found?.field, "path", path);
			assert.match(found?.message ?? "", /outside the project/, path);
		}
	});

	it("rejects a symlink inside the project that points outside it", () => {
		const found = problem({ name: "a", kind: "file", path: "link/id" }, { "/work/app/link": "/home/me/.ssh" });
		assert.equal(found?.field, "path");
		assert.match(found?.message ?? "", /\/home\/me\/\.ssh\/id/);
	});

	it("rejects a not yet existing target under a symlink that points outside", () => {
		assert.ok(problem({ name: "a", kind: "path", path: "link/new.txt" }, { "/work/app/link": "/tmp/elsewhere" }));
	});

	it("accepts a symlink that points to another place inside the project", () => {
		assert.equal(problem({ name: "a", kind: "file", path: "alias/x" }, { "/work/app/alias": "/work/app/real" }), undefined);
	});

	it("accepts a project reached through a symlinked working directory", () => {
		const env = { cwd: "/link/app", home: "/home/me", realpath: (path: string) => path.replace(/^\/link/, "/real") };
		assert.equal(confinementProblem({ name: "a", kind: "file", path: "src/a.ts" }, env), undefined);
		assert.ok(confinementProblem({ name: "a", kind: "file", path: "/link/other" }, env));
	});

	it("applies to a Dynamic command's cwd and to nothing else of a Dynamic Ref", () => {
		assert.equal(problem({ name: "a", kind: "dynamic", command: ["ls"], cwd: "sub" }), undefined);
		assert.equal(problem({ name: "a", kind: "dynamic", command: ["ls"] }), undefined);
		assert.equal(problem({ name: "a", kind: "dynamic", url: "https://example.com" }), undefined);
		assert.equal(problem({ name: "a", kind: "dynamic", command: ["ls"], cwd: "../up" })?.field, "cwd");
	});

	it("has nothing to say about a Snippet", () => {
		assert.equal(problem({ name: "a", kind: "snippet", text: "../../etc" }), undefined);
	});
});

describe("parseLibrary with a check", () => {
	const text = JSON.stringify({
		version: 1,
		refs: [
			{ name: "ok", kind: "file", path: "a.txt" },
			{ name: "bad", kind: "file", path: "../outside" },
			{ name: "snip", kind: "snippet", text: "x" },
		],
	});

	it("skips a Ref the check refuses, with one warning naming the file and the JSON path", () => {
		const result = parseLibrary(text, "/work/app/.pi/pi-context-refs.json", (ref) => confinementProblem(ref, files()));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.refs.map((ref) => ref.name),
			["ok", "snip"],
		);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0] ?? "", /^\/work\/app\/\.pi\/pi-context-refs\.json \$\.refs\[1\]\.path: .*outside the project/);
	});

	it("keeps the first Ref of a name when a later Ref of that name is refused", () => {
		const both = JSON.stringify({
			version: 1,
			refs: [
				{ name: "x", kind: "file", path: "../outside" },
				{ name: "X", kind: "file", path: "inside" },
			],
		});
		const result = parseLibrary(both, "f.json", (ref) => confinementProblem(ref, files()));
		assert.equal(result.ok && result.refs.length, 1);
		assert.equal(result.ok && result.refs[0]?.name, "X");
	});
});
