import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBuiltins } from "../../src/core/builtins.ts";
import type { CommandRequest, CommandResult } from "../../src/core/dynamic.ts";
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
const noCommands = async (): Promise<never> => {
	throw new Error("no command should run");
};
const ENV: ExpandEnv = { cwd: "/work/repo", home: "/home/me", readFile: disk({}), runCommand: noCommands, isGitWorkTree: async () => true };
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
		assert.deepEqual(result, { text: "#1 #unknown [ref:nope]", failures: [] });
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

	it("leaves a Dynamic Ref with a URL as typed", async () => {
		const url: Ref = { name: "page", kind: "dynamic", url: "https://example.com/" };
		assert.equal(await expand("see #page", [url]), "see #page");
	});

	it("runs a Built-in Ref that no saved Ref shadows, and lets a saved Ref with its name win", async () => {
		const log: CommandRequest[] = [];
		const env = runs({ git: out("+x\n"), npm: out("mine") }, log);
		const withBuiltins = (refs: Ref[]) => addBuiltins(visibleRefs(refs), true);
		const plain = await expandRefs("#diff", withBuiltins([]), env);
		assert.ok(plain.text.includes("$ git diff\n+x"), plain.text);
		const shadowed = await expandRefs("#diff", withBuiltins([{ ...tests, name: "diff" }]), env);
		assert.ok(shadowed.text.includes("$ npm test\nmine"), shadowed.text);
	});
});
