import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { type ExpandEnv, expandRefs } from "../../src/core/expand.ts";
import type { Ref } from "../../src/core/library.ts";
import { visibleRefs } from "../../src/core/resolve.ts";

/** A file reader over an in-memory disk; a value that is an Error is thrown, as the file system would. */
function disk(files: Record<string, string | Uint8Array | Error>): ExpandEnv["readFile"] {
	return async (path) => {
		const content = files[path];
		if (content === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		if (content instanceof Error) throw content;
		return typeof content === "string" ? new TextEncoder().encode(content) : content;
	};
}
const ENV: ExpandEnv = { cwd: "/work/repo", home: "/home/me", readFile: disk({}), truncateHead, imageType: async () => null };
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

	it("leaves a Dynamic ref as typed until Dynamic refs are built", async () => {
		const others: Ref[] = [{ name: "diff", kind: "dynamic", command: ["git", "diff"] }];
		assert.equal(await expand("#diff and [ref:diff]", others), "#diff and [ref:diff]");
	});

	it("leaves a Scoped Ref as typed until its scope is matched", async () => {
		const scoped: Ref = { name: "here", kind: "snippet", text: "x", scope: { path: "/work/repo" } };
		assert.equal(await expand("#here", [scoped]), "#here");
	});

	it("returns text with no ref tokens unchanged", async () => {
		assert.equal(await expand("plain words", refs), "plain words");
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
