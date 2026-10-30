import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest, Verdict } from "../../src/core/approval.ts";
import { BUILTIN_REFS } from "../../src/core/builtins.ts";
import type { CommandRequest, CommandResult } from "../../src/core/dynamic.ts";
import { type ExpandEnv, expandRefs } from "../../src/core/expand.ts";
import type { Ref } from "../../src/core/library.ts";
import { resolveRefs, visibleRefs } from "../../src/core/resolve.ts";
import type { FetchRequest, FetchResult } from "../../src/core/url.ts";

/** A file reader over an in-memory disk; a value that is an Error is thrown, as the file system would. */
function disk(files: Record<string, string | Uint8Array | Error>): ExpandEnv["readFile"] {
	return async (path) => {
		const content = files[path];
		if (content === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		if (content instanceof Error) throw content;
		return typeof content === "string" ? new TextEncoder().encode(content) : content;
	};
}
const noCommands = async (): Promise<never> => {
	throw new Error("no command should run");
};
const noPages = async (): Promise<never> => {
	throw new Error("no page should be fetched");
};
const ENV: ExpandEnv = {
	cwd: "/work/repo",
	home: "/home/me",
	readFile: disk({}),
	truncateHead,
	imageType: async () => null,
	runCommand: noCommands,
	fetchUrl: noPages,
	isGitWorkTree: async () => true,
};
const snippet = (name: string, text: string): Ref => ({ name, kind: "snippet", text });
const path = (name: string, target: string): Ref => ({ name, kind: "path", path: target });
const expand = async (text: string, refs: Ref[], env: ExpandEnv = ENV): Promise<string> => (await expandRefs(text, visibleRefs(refs), env)).text;

describe("Snippet", () => {
	const refs = [snippet("terse", "Be brief."), snippet("loop", "see #terse and [ref:terse]")];

	it("replaces a typed #name and a Placeholder by its saved text", async () => {
		assert.equal(await expand("please #terse", refs), "please Be brief.");
		assert.equal(await expand("please [ref:terse]", refs), "please Be brief.");
	});

	it("is sent literally, never scanned again for more refs", async () => {
		assert.equal(await expand("go #loop", refs), "go see #terse and [ref:terse]");
	});

	it("expands at every occurrence", async () => {
		assert.equal(await expand("#terse #terse", refs), "Be brief. Be brief.");
	});

	it("keeps multi-line text and replacement markers as written", async () => {
		assert.equal(await expand("a #x b", [snippet("x", "line1\nline2 $& $1 $$")]), "a line1\nline2 $& $1 $$ b");
	});

	it("leaves the punctuation after a typed token in place", async () => {
		assert.equal(await expand("be #terse, then #terse.", refs), "be Be brief., then Be brief..");
	});
});

describe("Path", () => {
	it("prints a path inside the working directory relative to it", async () => {
		assert.equal(await expand("see #a", [path("a", "src/api.ts")]), "see src/api.ts");
		assert.equal(await expand("see #a", [path("a", "./src/../src/api.ts")]), "see src/api.ts");
		assert.equal(await expand("see #a", [path("a", "/work/repo/src/api.ts")]), "see src/api.ts");
	});

	it("prints the working directory itself as a dot", async () => {
		assert.equal(await expand("in #a", [path("a", ".")]), "in .");
		assert.equal(await expand("in #a", [path("a", "/work/repo")]), "in .");
	});

	it("prints a path outside the working directory in full", async () => {
		assert.equal(await expand("see #a", [path("a", "/etc/hosts")]), "see /etc/hosts");
		assert.equal(await expand("see #a", [path("a", "../other/x.md")]), "see /work/other/x.md");
		assert.equal(await expand("see #a", [path("a", "/work/repo-other/x")]), "see /work/repo-other/x");
	});

	it("expands ~ to the home directory", async () => {
		assert.equal(await expand("see #a", [path("a", "~/notes/todo.md")]), "see /home/me/notes/todo.md");
		assert.equal(await expand("see #a", [path("a", "~")]), "see /home/me");
	});

	it("prints a path inside the working directory relative even when it was written with ~", async () => {
		assert.equal(await expand("see #a", [path("a", "~/../../work/repo/src")]), "see src");
	});

	it("treats a name that merely starts with two dots as inside the working directory", async () => {
		assert.equal(await expand("see #a", [path("a", "..cache/x")]), "see ..cache/x");
	});

	it("does not check that the path exists", async () => {
		assert.equal(await expand("create #a", [path("a", "not/yet/there.ts")]), "create not/yet/there.ts");
	});

	it("keeps a ~name path that is not the home directory as a relative path", async () => {
		assert.equal(await expand("see #a", [path("a", "~other/x")]), "see ~other/x");
	});
});

describe("what does not expand", () => {
	const refs = [snippet("terse", "Be brief."), path("agents", "AGENTS.md")];

	it("passes through a name that matches no Ref", async () => {
		const text = "#1 priority, issue #42, #unknown, # heading, [ref:unknown]";
		assert.equal(await expand(text, refs), text);
	});

	it("matches the whole name only", async () => {
		assert.equal(await expand("#ters #terse2 #terse-x", refs), "#ters #terse2 #terse-x");
	});

	it("matches case-insensitively", async () => {
		assert.equal(await expand("#TERSE [ref:Agents]", refs), "Be brief. AGENTS.md");
	});

	it("leaves a Scoped Ref as typed until its scope is matched", async () => {
		const scoped: Ref = { name: "here", kind: "snippet", text: "x", scope: { path: "/work/repo" } };
		assert.equal(await expand("#here", [scoped]), "#here");
	});

	it("returns text with no ref tokens unchanged", async () => {
		assert.equal(await expand("plain words", refs), "plain words");
	});
});

describe("Bundle", async () => {
	const tagged = (ref: Ref, ...tags: string[]): Ref => ({ ...ref, tags });
	const refs = [
		tagged(snippet("terse", "Be brief."), "style"),
		tagged(path("agents", "AGENTS.md"), "docs", "Style"),
		tagged(path("readme", "README.md"), "docs"),
		snippet("loose", "Untagged."),
	];

	it("expands #tag:<tag> to every member, each as it would be on its own, in order", async () => {
		assert.equal(await expand("read #tag:docs now", refs), "read AGENTS.md README.md now");
		assert.equal(await expand("#tag:style", refs), "Be brief. AGENTS.md");
	});

	it("matches the tag case-insensitively, as a typed token", async () => {
		assert.equal(await expand("#TAG:DOCS", refs), "AGENTS.md README.md");
	});

	it("ends the token like a name, so the sentence can go on", async () => {
		assert.equal(await expand("read #tag:docs, then #tag:style.", refs), "read AGENTS.md README.md, then Be brief..");
	});

	it("passes an unknown tag through unchanged", async () => {
		assert.equal(await expand("see #tag:nope and #tag:", refs), "see #tag:nope and #tag:");
	});

	it("leaves a [ref:tag:<tag>] Placeholder alone, because only a typed token is a Bundle", async () => {
		assert.equal(await expand("[ref:tag:docs]", refs), "[ref:tag:docs]");
	});

	it("does not repeat a member that the message already names, wherever it sits", async () => {
		assert.equal(await expand("#tag:docs #agents", refs), "README.md AGENTS.md");
		assert.equal(await expand("#agents #tag:docs", refs), "AGENTS.md README.md");
		assert.equal(await expand("[ref:readme] #tag:docs", refs), "README.md AGENTS.md");
	});

	it("does not repeat a member that an earlier Bundle gave", async () => {
		assert.equal(await expand("#tag:style then #tag:docs", refs), "Be brief. AGENTS.md then README.md");
	});

	it("drops a Bundle that has nothing left to add, with the space before it", async () => {
		assert.equal(await expand("#tag:docs and #tag:docs", refs), "AGENTS.md README.md and");
		assert.equal(await expand("#agents #readme #tag:docs", refs), "AGENTS.md README.md");
		assert.equal(await expand("#tag:docs\n#tag:docs", refs), "AGENTS.md README.md\n");
	});

	it("still expands a member named twice outside the Bundle at every occurrence", async () => {
		assert.equal(await expand("#terse #terse #tag:style", refs), "Be brief. Be brief. AGENTS.md");
	});

	it("leaves a Ref named tag to the plain #name rule", async () => {
		assert.equal(await expand("#tag", [snippet("tag", "T")]), "T");
	});

	it("gives a File member as a Context block after the text, not as a Placeholder", async () => {
		const members = [
			tagged({ name: "api", kind: "file", path: "src/api.ts" }, "ctx"),
			tagged(snippet("terse", "Be brief."), "ctx"),
			tagged({ name: "notes", kind: "file", path: "notes.md" }, "ctx"),
		];
		const files = disk({ "/work/repo/src/api.ts": "export {};\n", "/work/repo/notes.md": "N" });
		const result = await expandRefs("see #tag:ctx now", visibleRefs(members), { ...ENV, readFile: files });
		assert.equal(
			result.text,
			[
				"see Be brief. now",
				'<context-ref name="api" kind="file" path="src/api.ts" bytes="11">\nexport {};\n\n</context-ref>',
				'<context-ref name="notes" kind="file" path="notes.md" bytes="1">\nN\n</context-ref>',
			].join("\n\n"),
		);
		assert.deepEqual(result.failures, []);
	});

	it("gives one block for a File member the message also names, and none for one already sent", async () => {
		const members = [tagged({ name: "api", kind: "file", path: "src/api.ts" }, "ctx"), tagged({ name: "old", kind: "file", path: "old.md" }, "ctx")];
		const env = { ...ENV, readFile: disk({ "/work/repo/src/api.ts": "A", "/work/repo/old.md": "new" }) };
		const sent = '<context-ref name="old" kind="file" path="old.md" bytes="3">\nold\n</context-ref>';
		const { text } = await expandRefs(`#api #tag:ctx\n\n${sent}`, visibleRefs(members), env);
		assert.equal(text.match(/<context-ref name="api"/g)?.length, 1);
		assert.equal(text.match(/<context-ref name="old"/g)?.length, 1);
		assert.ok(text.startsWith("#api \n\n") || text.startsWith("#api\n\n"), text);
	});

	it("reports a File member that cannot be read, and sends the others", async () => {
		const members = [tagged({ name: "gone", kind: "file", path: "gone.md" }, "ctx"), tagged(snippet("terse", "Be brief."), "ctx")];
		const result = await expandRefs("#tag:ctx", visibleRefs(members), ENV);
		assert.deepEqual(result.failures, [{ name: "gone", reason: "gone.md does not exist" }]);
		assert.ok(result.text.startsWith('Be brief.\n\n<context-ref name="gone"'), result.text);
	});

	it("runs a command member once and gives it a Context block, and fetches a URL member as a block too", async () => {
		const log: CommandRequest[] = [];
		const env: ExpandEnv = {
			...ENV,
			runCommand: async (request) => {
				log.push(request);
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			},
			fetchUrl: async () => ({ killed: false, status: 200, contentType: "text/plain", bytes: new TextEncoder().encode("page text") }),
		};
		const members = [
			tagged(snippet("terse", "Be brief."), "ctx"),
			tagged({ name: "tests", kind: "dynamic", command: ["npm", "test"] }, "ctx"),
			tagged({ name: "page", kind: "dynamic", url: "https://example.com/" }, "ctx"),
		];
		const text = await expand("#tag:ctx #tests", members, env);
		// The Bundle comes first in the message, so its URL member's block comes before the block of the command the message names itself.
		const page = '<context-ref name="page" kind="dynamic" source="https://example.com/" bytes="34">\nGET https://example.com/\npage text\n</context-ref>';
		assert.ok(text.startsWith(`Be brief. #tests\n\n${page}\n\n<context-ref name="tests" kind="dynamic"`), text);
		assert.equal(log.length, 1);
	});

	it("does not expand the text of a Snippet member again", async () => {
		const members = [tagged(snippet("a", "see #b and #tag:t"), "t"), tagged(snippet("b", "B"), "t")];
		assert.equal(await expand("#tag:t", members), "see #b and #tag:t B");
	});

	it("leaves a Scoped Ref out of the Bundle until its scope is matched", async () => {
		const scoped: Ref = { ...tagged(snippet("here", "x"), "t"), scope: { path: "/work/repo" } };
		assert.equal(await expand("#tag:t", [scoped, tagged(snippet("b", "B"), "t")]), "B");
		assert.equal(await expand("#tag:t", [scoped]), "#tag:t");
	});
});

describe("visibleRefs", () => {
	it("keeps the first Ref of a name, compared case-insensitively", async () => {
		const visible = visibleRefs([snippet("Api", "first"), snippet("api", "second")]);
		assert.equal(visible.size, 1);
		assert.deepEqual(visible.get("api"), snippet("Api", "first"));
	});
});

describe("File", () => {
	const api: Ref = { name: "api", kind: "file", path: "src/api.ts" };
	const env = (files: Record<string, string | Uint8Array | Error>): ExpandEnv => ({ ...ENV, readFile: disk(files) });
	const block = (attributes: string, body: string) => `<context-ref ${attributes}>\n${body}\n</context-ref>`;

	it("keeps the token in the prose and adds one Context block after a blank line", async () => {
		const text = await expand("read #api and [ref:api] now", [api], env({ "/work/repo/src/api.ts": "export {};\n" }));
		assert.equal(text, `read #api and [ref:api] now\n\n${block('name="api" kind="file" path="src/api.ts" bytes="11"', "export {};\n")}`);
	});

	it("gives one block for a File used twice, and one per File in order of first appearance", async () => {
		const refs: Ref[] = [api, { name: "b", kind: "file", path: "/etc/b.txt" }, { name: "c", kind: "file", path: "c.txt" }];
		const files = { "/work/repo/src/api.ts": "A", "/etc/b.txt": "B", "/work/repo/c.txt": "C" };
		const text = await expand("#c #api #c [ref:b] #api", refs, env(files));
		const names = [...text.matchAll(/<context-ref name="([^"]+)"/g)].map((match) => match[1]);
		assert.deepEqual(names, ["c", "api", "b"]);
		assert.ok(text.startsWith('#c #api #c [ref:b] #api\n\n<context-ref name="c"'));
		assert.ok(text.includes('</context-ref>\n\n<context-ref name="api"'));
	});

	it("resolves the path against the working directory and expands ~, and shows an outside path in full", async () => {
		const refs: Ref[] = [
			{ name: "rel", kind: "file", path: "./src/../src/api.ts" },
			{ name: "home", kind: "file", path: "~/notes.md" },
			{ name: "abs", kind: "file", path: "/etc/hosts" },
		];
		const files = { "/work/repo/src/api.ts": "1", "/home/me/notes.md": "2", "/etc/hosts": "3" };
		const text = await expand("#rel #home #abs", refs, env(files));
		assert.ok(text.includes('name="rel" kind="file" path="src/api.ts" bytes="1"'), text);
		assert.ok(text.includes('name="home" kind="file" path="/home/me/notes.md" bytes="1"'), text);
		assert.ok(text.includes('name="abs" kind="file" path="/etc/hosts" bytes="1"'), text);
	});

	it("measures bytes as UTF-8, removes the BOM and control characters, and leaves a closing tag in the content alone", async () => {
		const content = new TextEncoder().encode("\u{feff}é\x1b[0m世</context-ref>\r\n");
		const text = await expand("#api", [api], env({ "/work/repo/src/api.ts": content }));
		assert.ok(text.endsWith(`bytes="24">\né[0m世</context-ref>\r\n\n</context-ref>`), JSON.stringify(text));
	});

	it("gives an empty file an empty block with bytes 0", async () => {
		const text = await expand("#api", [api], env({ "/work/repo/src/api.ts": "" }));
		assert.equal(text, `#api\n\n${block('name="api" kind="file" path="src/api.ts" bytes="0"', "")}`);
	});

	it("does not expand a File whose block is already in the message, and still expands the others", async () => {
		const refs: Ref[] = [api, { name: "b", kind: "file", path: "b.txt" }];
		const sent = `see [ref:api] and [ref:b]\n\n${block('name="API" kind="file" path="src/api.ts" bytes="3"', "old")}`;
		const text = await expand(sent, refs, env({ "/work/repo/src/api.ts": "new", "/work/repo/b.txt": "B" }));
		assert.ok(text.startsWith(sent), "the message is kept as it was");
		assert.equal(text.match(/<context-ref name="api"/gi)?.length, 1);
		assert.ok(text.endsWith(block('name="b" kind="file" path="b.txt" bytes="1"', "B")));
	});

	it("returns the message unchanged when every block it needs is already there", async () => {
		const sent = `see [ref:api]\n\n${block('name="api" kind="file" path="src/api.ts" bytes="3"', "old")}`;
		const result = await expandRefs(sent, visibleRefs([api]), env({}));
		assert.equal(result.text, sent);
		assert.deepEqual(result.failures, []);
	});

	describe("when the file cannot be read", () => {
		const fails = async (error: Error | undefined, files: Record<string, string | Uint8Array | Error> = {}) => {
			const result = await expandRefs("see #api", visibleRefs([api]), env(error ? { "/work/repo/src/api.ts": error, ...files } : files));
			assert.equal(result.failures.length, 1);
			return result;
		};

		it("reports a missing file and puts a Failure note in the text", async () => {
			const result = await fails(undefined);
			assert.deepEqual(result.failures, [{ name: "api", reason: "src/api.ts does not exist" }]);
			assert.equal(
				result.text,
				`see #api\n\n<context-ref name="api" kind="file" path="src/api.ts" bytes="0" error="src/api.ts does not exist">\n\n</context-ref>`,
			);
		});

		it("reports a directory and suggests a Path Ref or a Dynamic ls Ref", async () => {
			const result = await fails(Object.assign(new Error("EISDIR"), { code: "EISDIR" }));
			assert.match(result.failures[0]?.reason ?? "", /^src\/api\.ts is a directory; save it as a Path Ref, or as a Dynamic Ref that runs \["ls", /);
		});

		it("reports an unreadable file with the system's reason", async () => {
			const result = await fails(Object.assign(new Error("EACCES: permission denied, open '/work/repo/src/api.ts'"), { code: "EACCES" }));
			assert.equal(result.failures[0]?.reason, "src/api.ts cannot be read (EACCES)");
		});

		it("reports an error without a code", async () => {
			const result = await fails(new Error("boom"));
			assert.equal(result.failures[0]?.reason, "src/api.ts cannot be read (boom)");
		});

		it("still reads the other Files and fails each bad one on its own", async () => {
			const refs: Ref[] = [api, { name: "b", kind: "file", path: "b.txt" }];
			const result = await expandRefs("#api #b", visibleRefs(refs), env({ "/work/repo/b.txt": "B" }));
			assert.deepEqual(
				result.failures.map((failure) => failure.name),
				["api"],
			);
			assert.ok(result.text.includes('name="b" kind="file" path="b.txt" bytes="1">\nB\n'));
		});
	});

	it("never fails on a token that matches nothing", async () => {
		const result = await expandRefs("#1 #unknown [ref:nope]", visibleRefs([api]), env({}));
		assert.deepEqual(result, { text: "#1 #unknown [ref:nope]", images: [], failures: [] });
	});
});

describe("Recent refs", () => {
	const block = (attributes: string, body: string) => `<context-ref ${attributes}>\n${body}\n</context-ref>`;
	const used =
		(...paths: string[]): ExpandEnv["usedFile"] =>
		(path) =>
			paths.includes(path);
	const env = (files: Record<string, string | Uint8Array | Error>, usedFile?: ExpandEnv["usedFile"]): ExpandEnv => ({
		...ENV,
		readFile: disk(files),
		...(usedFile ? { usedFile } : {}),
	});

	describe("a path Placeholder", () => {
		it("prints the path, relative inside the working directory and absolute outside, with no saved Ref and no check", async () => {
			assert.equal(await expand("see [ref:src/api.ts] and [ref:./README.md]", []), "see src/api.ts and README.md");
			assert.equal(await expand("see [ref:/etc/hosts] and [ref:~/notes/a.md]", []), "see /etc/hosts and /home/me/notes/a.md");
		});

		it("reads a quoted path with spaces", async () => {
			assert.equal(await expand('see [ref:"my dir/a b.ts"]', []), "see my dir/a b.ts");
		});

		it("never reads the file", async () => {
			const result = await expandRefs("[ref:src/api.ts]", visibleRefs([]), env({}));
			assert.deepEqual(result, { text: "src/api.ts", images: [], failures: [] });
		});

		it("does not change a Placeholder that names a saved Ref", async () => {
			assert.equal(await expand("[ref:api]", [path("api", "docs/api.md")]), "docs/api.md");
		});

		it("does not expand a typed #src/api.ts", async () => {
			assert.equal(await expand("see #src/api.ts and #./README.md", []), "see #src/api.ts and #./README.md");
		});

		it("prints the path for a Placeholder at every occurrence", async () => {
			assert.equal(await expand("[ref:a/b.ts] [ref:a/b.ts]", []), "a/b.ts a/b.ts");
		});
	});

	describe("a file Placeholder", () => {
		const files = { "/work/repo/src/api.ts": "export {};\n", "/work/repo/README.md": "# hi\n" };

		it("sends the file as a Context block named by its path when the session used it", async () => {
			const text = await expand("read [ref:file:src/api.ts]", [], env(files, used("/work/repo/src/api.ts")));
			assert.equal(text, `read [ref:file:src/api.ts]\n\n${block('name="src/api.ts" kind="file" path="src/api.ts" bytes="11"', "export {};\n")}`);
		});

		it("names a root file with ./ so its name never clashes with a saved Ref", async () => {
			const text = await expand("[ref:file:./README.md]", [], env(files, used("/work/repo/README.md")));
			assert.ok(text.includes('<context-ref name="./README.md" kind="file" path="README.md" bytes="5">'), text);
		});

		it("reads a quoted path with spaces", async () => {
			const text = await expand('[ref:file:"my dir/a b.ts"]', [], env({ "/work/repo/my dir/a b.ts": "x" }, used("/work/repo/my dir/a b.ts")));
			assert.ok(text.includes('name="my dir/a b.ts" kind="file" path="my dir/a b.ts" bytes="1"'), text);
		});

		it("leaves the Placeholder as typed, and reads nothing, when the session did not use the file", async () => {
			const result = await expandRefs("[ref:file:src/api.ts]", visibleRefs([]), env(files, used("/work/repo/other.ts")));
			assert.deepEqual(result, { text: "[ref:file:src/api.ts]", images: [], failures: [] });
		});

		it("leaves the Placeholder as typed when the environment has no record of used files", async () => {
			assert.equal(await expand("[ref:file:src/api.ts]", [], env(files)), "[ref:file:src/api.ts]");
		});

		it("asks about the absolute path the Placeholder means, however it is written", async () => {
			const asked: string[] = [];
			await expand("[ref:file:./src/../src/api.ts] [ref:file:~/x.md] [ref:file:/etc/hosts]", [], {
				...env(files),
				usedFile: (path) => {
					asked.push(path);
					return false;
				},
			});
			assert.deepEqual(asked, ["/work/repo/src/api.ts", "/home/me/x.md", "/etc/hosts"]);
		});

		it("gives one block for a file used twice, and none when the message already carries it", async () => {
			const twice = await expand("[ref:file:src/api.ts] [ref:file:src/api.ts]", [], env(files, used("/work/repo/src/api.ts")));
			assert.equal(twice.match(/<context-ref /g)?.length, 1);
			const sent = `see [ref:file:src/api.ts]\n\n${block('name="src/api.ts" kind="file" path="src/api.ts" bytes="3"', "old")}`;
			assert.equal(await expand(sent, [], env(files, used("/work/repo/src/api.ts"))), sent);
		});

		it("reports a used file that is gone now as a failure, with a Failure note", async () => {
			const result = await expandRefs("[ref:file:src/gone.ts]", visibleRefs([]), env({}, used("/work/repo/src/gone.ts")));
			assert.deepEqual(result.failures, [{ name: "src/gone.ts", reason: "src/gone.ts does not exist" }]);
			assert.ok(result.text.includes('name="src/gone.ts" kind="file" path="src/gone.ts" bytes="0" error="src/gone.ts does not exist"'), result.text);
		});
	});
});

describe("File limits", () => {
	const api: Ref = { name: "api", kind: "file", path: "src/api.ts" };
	const file = "/work/repo/src/api.ts";
	const env = (content: string | Uint8Array, imageType: ExpandEnv["imageType"] = async () => null): ExpandEnv => ({
		...ENV,
		readFile: disk({ [file]: content }),
		imageType,
	});
	const lines = (count: number, width = 9) => Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(width, "0")}\n`).join("");
	const sendFile = (content: string | Uint8Array, ref: Ref = api, imageType?: ExpandEnv["imageType"]) =>
		expandRefs("see #api", visibleRefs([ref]), env(content, imageType));
	const head = (text: string) => text.match(/<context-ref [^>]*>/)?.[0] ?? "";
	const body = (text: string) => text.slice(text.indexOf(">\n") + 2, text.lastIndexOf("\n</context-ref>"));

	describe("the default cap", () => {
		it("sends a file of exactly 50 KB whole", async () => {
			const content = "x".repeat(99).concat("\n").repeat(512);
			assert.equal(Buffer.byteLength(content), 51200);
			const { text } = await sendFile(content);
			assert.equal(head(text), '<context-ref name="api" kind="file" path="src/api.ts" bytes="51200">');
			assert.equal(body(text), content);
		});

		it("cuts a file one byte over 50 KB at the last whole line, marks the block truncated and says where to continue", async () => {
			const content = `${"x".repeat(99)}\n`.repeat(512).concat("y");
			const { text, failures } = await sendFile(content);
			const kept = `${"x".repeat(99)}\n`.repeat(511).concat("x".repeat(99));
			const note = "[Truncated at 50 KB: showing lines 1-512 of 513. Use the read tool with offset=513 to read the rest.]";
			assert.deepEqual(failures, []);
			assert.equal(body(text), `${kept}\n${note}`);
			assert.match(head(text), /^<context-ref name="api" kind="file" path="src\/api\.ts" bytes="\d+" truncated="50 KB">$/);
		});

		it("sends a file of exactly 2000 lines whole", async () => {
			const { text } = await sendFile(lines(2000));
			assert.equal(body(text), lines(2000));
			assert.ok(!head(text).includes("truncated"));
		});

		it("cuts a file of 2001 lines at 2000", async () => {
			const { text } = await sendFile(lines(2001));
			const note = "[Truncated at 2000 lines: showing lines 1-2000 of 2001. Use the read tool with offset=2001 to read the rest.]";
			assert.equal(body(text), `${lines(2000).slice(0, -1)}\n${note}`);
			assert.match(head(text), / truncated="2000 lines">$/);
		});

		it("declares the bytes of the body including the note", async () => {
			const { text } = await sendFile(lines(2500));
			const declared = Number(head(text).match(/bytes="(\d+)"/)?.[1]);
			assert.equal(declared, Buffer.byteLength(body(text)));
		});

		it("counts the cap in bytes, not characters", async () => {
			const content = "\u4e16".repeat(17_000).concat("\n").repeat(2);
			const { text } = await sendFile(content);
			assert.match(head(text), / truncated="50 KB">$/);
			assert.ok(Buffer.byteLength(body(text)) < 51200 + 200);
		});

		it("says so when the first line alone is over the cap", async () => {
			const { text, failures } = await sendFile(`${"x".repeat(60_000)}\nsecond\n`);
			assert.deepEqual(failures, []);
			assert.equal(body(text), "[Truncated at 50 KB: line 1 is longer than the cap, so nothing is shown. Read it in parts with bash.]");
			assert.match(head(text), / truncated="50 KB">$/);
		});

		it("never blocks the send", async () => {
			const result = await sendFile(lines(5000));
			assert.deepEqual(result.failures, []);
			assert.ok(result.text.startsWith("see #api\n\n<context-ref "));
		});
	});

	describe("a per-Ref max_bytes", () => {
		const limited = (max_bytes: number): Ref => ({ ...api, kind: "file", max_bytes });

		it("raises the byte cap and lifts the line cap", async () => {
			const { text } = await sendFile(lines(3000), limited(100_000));
			assert.equal(body(text), lines(3000));
			assert.ok(!head(text).includes("truncated"));
		});

		it("cuts at the Ref's own cap and names it", async () => {
			const { text } = await sendFile(lines(3000), limited(2048));
			assert.match(head(text), / truncated="2 KB">$/);
			assert.match(body(text), /\[Truncated at 2 KB: showing lines 1-204 of 3000\. Use the read tool with offset=205 to read the rest\.\]$/);
		});

		it("names the 1 MB ceiling in megabytes", async () => {
			const { text } = await sendFile(lines(150_000), limited(1048576));
			assert.match(head(text), / truncated="1 MB">$/);
		});

		it("names an odd cap in bytes", async () => {
			const { text } = await sendFile(lines(100), limited(55));
			assert.match(head(text), / truncated="55 bytes">$/);
		});
	});

	describe("a binary file", () => {
		it("is a failure when a NUL byte is in the first 8 KB", async () => {
			const early = new Uint8Array(100).fill(65);
			early[5] = 0;
			const late = new Uint8Array(9000).fill(65);
			late[8191] = 0;
			for (const content of [early, late]) {
				const { text, failures } = await sendFile(content);
				assert.deepEqual(failures, [{ name: "api", reason: "src/api.ts is a binary file and cannot be sent as text" }]);
				assert.equal(
					text,
					'see #api\n\n<context-ref name="api" kind="file" path="src/api.ts" bytes="0" error="src/api.ts is a binary file and cannot be sent as text">\n\n</context-ref>',
				);
			}
		});

		it("is text when the first NUL byte comes after 8 KB", async () => {
			const bytes = new Uint8Array(9000).fill(65);
			bytes[8192] = 0;
			const { text, failures } = await sendFile(bytes);
			assert.deepEqual(failures, []);
			assert.equal(body(text), "A".repeat(8999));
		});
	});

	describe("an image", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3]);
		const asPng: ExpandEnv["imageType"] = async () => "image/png";

		it("is attached as it is, with an empty block naming it", async () => {
			const result = await sendFile(png, api, asPng);
			assert.deepEqual(result.failures, []);
			assert.equal(result.text, 'see #api\n\n<context-ref name="api" kind="file" path="src/api.ts" bytes="0">\n\n</context-ref>');
			assert.deepEqual(result.images, [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }]);
		});

		it("asks the detector about the absolute path", async () => {
			const asked: string[] = [];
			await sendFile(png, api, async (path) => {
				asked.push(path);
				return "image/png";
			});
			assert.deepEqual(asked, [file]);
		});

		it("takes an image of exactly 5 MB", async () => {
			const result = await sendFile(new Uint8Array(5 * 1024 * 1024), api, asPng);
			assert.deepEqual(result.failures, []);
			assert.equal(result.images.length, 1);
		});

		it("fails over 5 MB and suggests resizing, with no image attached", async () => {
			const result = await sendFile(new Uint8Array(5 * 1024 * 1024 + 1), api, asPng);
			assert.deepEqual(result.failures, [{ name: "api", reason: "src/api.ts is an image over 5 MB; resize it and try again" }]);
			assert.deepEqual(result.images, []);
			assert.match(result.text, /bytes="0" error="src\/api\.ts is an image over 5 MB; resize it and try again"/);
		});

		it("attaches each image in order, next to the text Files", async () => {
			const refs: Ref[] = [api, { name: "shot", kind: "file", path: "shot.png" }, { name: "note", kind: "file", path: "note.txt" }];
			const files = { [file]: "text", "/work/repo/shot.png": png, "/work/repo/note.txt": "n" };
			const result = await expandRefs("#api #shot #note", visibleRefs(refs), {
				...ENV,
				readFile: disk(files),
				imageType: async (path) => (path.endsWith(".png") ? "image/png" : null),
			});
			assert.equal(result.images.length, 1);
			assert.deepEqual(
				[...result.text.matchAll(/<context-ref name="([^"]+)"/g)].map((match) => match[1]),
				["api", "shot", "note"],
			);
		});

		it("has no images when nothing is attached", async () => {
			assert.deepEqual((await sendFile("plain")).images, []);
		});
	});
});

describe("Dynamic command", () => {
	const tests: Ref = { name: "tests", kind: "dynamic", command: ["npm", "test"] };
	const block = (attributes: string, body: string) => `<context-ref ${attributes}>\n${body}\n</context-ref>`;
	/** An env whose runner answers by program name and logs each request. */
	const runs = (answers: Record<string, CommandResult | Error>, log: CommandRequest[] = []): ExpandEnv => ({
		...ENV,
		runCommand: async (request) => {
			log.push(request);
			const answer = answers[request.argv[0] ?? ""];
			if (answer === undefined || answer instanceof Error) throw answer ?? new Error("unexpected command");
			return answer;
		},
	});
	const out = (stdout: string): CommandResult => ({ stdout, stderr: "", code: 0, killed: false });

	it("keeps the token in the prose and adds one Context block after a blank line", async () => {
		const text = await expand("run #tests and [ref:tests]", [tests], runs({ npm: out("ok\n") }));
		assert.equal(text, `run #tests and [ref:tests]\n\n${block('name="tests" kind="dynamic" source="npm test" bytes="14"', "$ npm test\nok\n")}`);
	});

	it("runs a Ref used twice once, in the session directory, and runs it again on the next send", async () => {
		const log: CommandRequest[] = [];
		const env = runs({ npm: out("ok") }, log);
		await expand("#tests #tests [ref:tests]", [tests], env);
		assert.equal(log.length, 1);
		assert.equal(log[0]?.cwd, "/work/repo");
		await expand("#tests", [tests], env);
		assert.equal(log.length, 2);
	});

	it("resolves the Ref's cwd against the session directory and expands ~", async () => {
		const log: CommandRequest[] = [];
		const env = runs({ npm: out("") }, log);
		await expand(
			"#a #b #c",
			[
				{ ...tests, name: "a", cwd: "sub/dir" },
				{ ...tests, name: "b", cwd: "~/proj" },
				{ ...tests, name: "c", cwd: "/srv" },
			],
			env,
		);
		assert.deepEqual(
			log.map((request) => request.cwd),
			["/work/repo/sub/dir", "/home/me/proj", "/srv"],
		);
	});

	it("starts every command before any finishes", async () => {
		let running = 0;
		let peak = 0;
		const env: ExpandEnv = {
			...ENV,
			runCommand: async () => {
				peak = Math.max(peak, ++running);
				await new Promise((resolve) => setTimeout(resolve, 10));
				running--;
				return out("x");
			},
		};
		await expand(
			"#a #b #c",
			[
				{ ...tests, name: "a" },
				{ ...tests, name: "b" },
				{ ...tests, name: "c" },
			],
			env,
		);
		assert.equal(peak, 3);
	});

	it("puts File and Dynamic blocks together in order of first appearance", async () => {
		const refs: Ref[] = [tests, { name: "api", kind: "file", path: "src/api.ts" }];
		const env: ExpandEnv = { ...runs({ npm: out("ok") }), readFile: disk({ "/work/repo/src/api.ts": "A" }) };
		const text = await expand("#tests #api", refs, env);
		assert.deepEqual(
			[...text.matchAll(/<context-ref name="([^"]+)"/g)].map((match) => match[1]),
			["tests", "api"],
		);
	});

	it("does not run a Ref whose block is already in the message", async () => {
		const sent = `see [ref:tests]\n\n${block('name="tests" kind="dynamic" source="npm test" bytes="3"', "old")}`;
		const result = await expandRefs(sent, visibleRefs([tests]), runs({}));
		assert.equal(result.text, sent);
	});

	it("passes the cancel signal to the runner", async () => {
		const log: CommandRequest[] = [];
		const controller = new AbortController();
		await expandRefs("#tests", visibleRefs([tests]), { ...runs({ npm: out("") }, log), signal: controller.signal });
		assert.equal(log[0]?.signal, controller.signal);
	});

	it("reports a failure with its reason and puts a Failure note in the text, and still sends the other blocks", async () => {
		const refs: Ref[] = [tests, { name: "lint", kind: "dynamic", command: ["eslint"] }];
		const result = await expandRefs("#tests #lint", visibleRefs(refs), runs({ npm: new Error("no such program"), eslint: out("clean") }));
		assert.deepEqual(result.failures, [{ name: "tests", reason: "npm test cannot start: no such program" }]);
		assert.ok(result.text.includes('name="tests" kind="dynamic" source="npm test" bytes="0" error="npm test cannot start: no such program"'), result.text);
		assert.ok(result.text.includes("$ eslint\nclean"), result.text);
	});

	it("fetches a Dynamic Ref with a URL once, however often it is mentioned, in the Ref's own timeout and cap", async () => {
		const log: FetchRequest[] = [];
		const env: ExpandEnv = {
			...ENV,
			fetchUrl: async (request): Promise<FetchResult> => {
				log.push(request);
				return { killed: false, status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<p>hi</p>") };
			},
		};
		const url: Ref = { name: "page", kind: "dynamic", url: "https://example.com/", timeout: 30, max_output: 2048 };
		const result = await expandRefs("see #page and [ref:page] #page", visibleRefs([url]), env);
		assert.equal(
			result.text,
			'see #page and [ref:page] #page\n\n<context-ref name="page" kind="dynamic" source="https://example.com/" bytes="34">\nGET https://example.com/\n<p>hi</p>\n</context-ref>',
		);
		assert.deepEqual(log, [{ name: "page", url: "https://example.com/", timeoutMs: 30_000, maxBytes: 2048 }]);
		assert.deepEqual(result.failures, []);
	});

	it("reports a URL that cannot be fetched as a failure and sends the other blocks", async () => {
		const env: ExpandEnv = {
			...ENV,
			fetchUrl: async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:9");
			},
			runCommand: runs({ npm: out("ok") }).runCommand,
		};
		const page: Ref = { name: "page", kind: "dynamic", url: "http://127.0.0.1:9/" };
		const result = await expandRefs("#page #tests", visibleRefs([page, tests]), env);
		assert.deepEqual(result.failures, [{ name: "page", reason: "http://127.0.0.1:9/ cannot be fetched: connect ECONNREFUSED 127.0.0.1:9" }]);
		assert.ok(result.text.includes("$ npm test\nok"), result.text);
	});

	it("runs a Built-in Ref that no saved Ref shadows, and lets a saved Ref with its name win", async () => {
		const log: CommandRequest[] = [];
		const env = runs({ git: out("+x\n"), npm: out("mine") }, log);
		const place = { cwd: "/work/repo", home: "/home/me", realpath: (path: string) => path, remotes: () => [] };
		const withBuiltins = (refs: Ref[]) => resolveRefs({ global: refs, project: [], builtin: BUILTIN_REFS }, place).visible;
		const plain = await expandRefs("#diff", withBuiltins([]), env);
		assert.ok(plain.text.includes("$ git diff\n+x"), plain.text);
		const shadowed = await expandRefs("#diff", withBuiltins([{ ...tests, name: "diff" }]), env);
		assert.ok(shadowed.text.includes("$ npm test\nmine"), shadowed.text);
	});

	describe("from the Project library", () => {
		const place = { cwd: "/work/repo", home: "/home/me", realpath: (path: string) => path, remotes: () => [] };
		const lint: Ref = { name: "lint", kind: "dynamic", command: ["eslint"] };
		const page: Ref = { name: "page", kind: "dynamic", url: "https://example.com/spec" };
		const layered = (project: Ref[], global: Ref[] = []) => resolveRefs({ global, project, builtin: BUILTIN_REFS }, place);
		const allow: Verdict = { allowed: true };

		it("asks about the exact definition of a command before running it, and runs it once approved", async () => {
			const log: CommandRequest[] = [];
			const asked: ApprovalRequest[] = [];
			const { visible, layers } = layered([{ ...tests, cwd: "sub" }]);
			const result = await expandRefs("#tests", visible, {
				...runs({ npm: out("ok") }, log),
				layers,
				approve: async (request) => {
					asked.push(request);
					return allow;
				},
			});
			assert.deepEqual(asked, [{ ref: { ...tests, cwd: "sub" }, definition: { source: "command", argv: ["npm", "test"], cwd: "/work/repo/sub" } }]);
			assert.ok(result.text.includes("$ npm test\nok"), result.text);
			assert.equal(log[0]?.cwd, "/work/repo/sub");
		});

		it("asks about the URL of a URL Ref before fetching it", async () => {
			const asked: ApprovalRequest[] = [];
			const fetched: string[] = [];
			const { visible, layers } = layered([page]);
			const result = await expandRefs("#page", visible, {
				...ENV,
				layers,
				approve: async (request) => {
					asked.push(request);
					return allow;
				},
				fetchUrl: async (request): Promise<FetchResult> => {
					fetched.push(request.url);
					return { killed: false, status: 200, contentType: "text/plain", bytes: new TextEncoder().encode("spec") };
				},
			});
			assert.deepEqual(
				asked.map((request) => request.definition),
				[{ source: "url", url: "https://example.com/spec" }],
			);
			assert.deepEqual(fetched, ["https://example.com/spec"]);
			assert.ok(result.text.includes("GET https://example.com/spec\nspec"), result.text);
		});

		it("does not run a command that is refused, and gives the reason in a Failure note", async () => {
			const log: CommandRequest[] = [];
			const { visible, layers } = layered([tests]);
			const result = await expandRefs("#tests", visible, {
				...runs({ npm: out("ok") }, log),
				layers,
				approve: async () => ({ allowed: false, reason: "you denied it" }),
			});
			assert.deepEqual(result.failures, [{ name: "tests", reason: "you denied it" }]);
			assert.ok(result.text.includes('name="tests" kind="dynamic" source="npm test" bytes="0" error="you denied it"'), result.text);
			assert.deepEqual(log, []);
		});

		it("does not fetch a URL that is refused", async () => {
			const { visible, layers } = layered([page]);
			const result = await expandRefs("#page", visible, { ...ENV, layers, approve: async () => ({ allowed: false, reason: "no" }) });
			assert.deepEqual(result.failures, [{ name: "page", reason: "no" }]);
			assert.ok(result.text.includes('source="https://example.com/spec" bytes="0" error="no"'), result.text);
		});

		it("is not run when nothing can approve it", async () => {
			const log: CommandRequest[] = [];
			const { visible, layers } = layered([tests]);
			const result = await expandRefs("#tests", visible, { ...runs({ npm: out("ok") }, log), layers });
			assert.deepEqual(result.failures, [{ name: "tests", reason: "it is not approved" }]);
			assert.deepEqual(log, []);
		});

		it("asks one Ref at a time, before any Ref of the message runs, and still runs the Refs that were approved", async () => {
			const log: string[] = [];
			let asking = 0;
			const { visible, layers } = layered([tests, lint]);
			const base = runs({ npm: out("ok"), eslint: out("clean") });
			const result = await expandRefs("#tests #lint", visible, {
				...base,
				layers,
				runCommand: async (request) => {
					log.push(`run ${request.name}`);
					return base.runCommand(request);
				},
				approve: async ({ ref }) => {
					asking += 1;
					assert.equal(asking, 1, "two questions at once");
					log.push(`ask ${ref.name}`);
					await new Promise((resolve) => setTimeout(resolve, 5));
					asking -= 1;
					return ref.name === "tests" ? allow : { allowed: false, reason: "denied" };
				},
			});
			assert.deepEqual(log, ["ask tests", "ask lint", "run tests"]);
			assert.deepEqual(result.failures, [{ name: "lint", reason: "denied" }]);
		});

		it("asks about a command that comes in through a Bundle", async () => {
			const log: CommandRequest[] = [];
			const asked: string[] = [];
			const { visible, layers } = layered([{ ...tests, tags: ["ci"] }]);
			const result = await expandRefs("#tag:ci", visible, {
				...runs({ npm: out("ok") }, log),
				layers,
				approve: async ({ ref }) => {
					asked.push(ref.name);
					return { allowed: false, reason: "denied" };
				},
			});
			assert.deepEqual(asked, ["tests"]);
			assert.equal(result.failures.length, 1);
			assert.deepEqual(log, []);
		});

		it("asks about a Project Ref that shadows a Built-in Ref", async () => {
			const asked: string[] = [];
			const { visible, layers } = layered([{ ...tests, name: "diff" }]);
			await expandRefs("#diff", visible, {
				...runs({ npm: out("ok") }),
				layers,
				approve: async ({ ref }) => {
					asked.push(ref.name);
					return allow;
				},
			});
			assert.deepEqual(asked, ["diff"]);
		});

		it("never asks about a Global library Ref or a Built-in Ref", async () => {
			const asked: string[] = [];
			const { visible, layers } = layered([], [lint]);
			const result = await expandRefs("#lint #status", visible, {
				...runs({ eslint: out("clean"), git: out("") }),
				layers,
				approve: async ({ ref }) => {
					asked.push(ref.name);
					return allow;
				},
			});
			assert.deepEqual(asked, []);
			assert.deepEqual(result.failures, []);
		});
	});
});
