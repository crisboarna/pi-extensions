import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextBlock } from "../../src/core/context-block.ts";
import {
	ageNote,
	createUsedFiles,
	isUsedProjectFile,
	MAX_RECENT,
	matchRecent,
	messagePaths,
	parseRecentTarget,
	placeholderTarget,
	resolveUsedPath,
	rowPath,
	toolUse,
} from "../../src/core/recent.ts";

const env = { cwd: "/work/app", home: "/home/me", tmpdir: "/tmp" };

describe("resolveUsedPath", () => {
	it("joins a relative path to the working directory and cleans it up", () => {
		assert.equal(resolveUsedPath("src/api.ts", env), "/work/app/src/api.ts");
		assert.equal(resolveUsedPath("./src/../src/api.ts", env), "/work/app/src/api.ts");
	});

	it("resolves the way pi does: a leading @ is dropped, ~ is the home directory, file:// is a path", () => {
		assert.equal(resolveUsedPath("@note.txt", env), "/work/app/note.txt");
		assert.equal(resolveUsedPath("~/notes/a.md", env), "/home/me/notes/a.md");
		assert.equal(resolveUsedPath("~", env), "/home/me");
		assert.equal(resolveUsedPath("file:///etc/hosts", env), "/etc/hosts");
		assert.equal(resolveUsedPath("/abs/x.ts", env), "/abs/x.ts");
	});

	it("turns unicode spaces into plain spaces", () => {
		assert.equal(resolveUsedPath("my\u202Fdir/a.ts", env), "/work/app/my dir/a.ts");
	});

	it("gives nothing for an empty path or a malformed file URL", () => {
		assert.equal(resolveUsedPath("", env), undefined);
		assert.equal(resolveUsedPath("   ", env), undefined);
		assert.equal(resolveUsedPath("@", env), undefined);
		assert.equal(resolveUsedPath("file://host/x", env), undefined);
	});
});

describe("toolUse", () => {
	it("counts read as a read, and edit and write as an edit", () => {
		assert.deepEqual(toolUse("read", { path: "src/a.ts" }, env), { path: "/work/app/src/a.ts", use: "read" });
		assert.deepEqual(toolUse("edit", { path: "@src/a.ts", edits: [] }, env), { path: "/work/app/src/a.ts", use: "edit" });
		assert.deepEqual(toolUse("write", { path: "out/b.txt", content: "x" }, env), { path: "/work/app/out/b.txt", use: "edit" });
	});

	it("ignores every other tool, whatever its arguments", () => {
		for (const name of ["ls", "find", "grep", "bash", "codemode", "mcp__fs__read_file", "fetch"]) {
			assert.equal(toolUse(name, { path: "src/a.ts" }, env), undefined, name);
		}
	});

	it("ignores a call without a text path", () => {
		assert.equal(toolUse("read", {}, env), undefined);
		assert.equal(toolUse("read", { path: 3 }, env), undefined);
		assert.equal(toolUse("read", undefined, env), undefined);
		assert.equal(toolUse("read", { path: "" }, env), undefined);
	});

	it("keeps only files inside the working directory", () => {
		assert.equal(toolUse("read", { path: "../other/a.ts" }, env), undefined);
		assert.equal(toolUse("read", { path: "/etc/hosts" }, env), undefined);
		assert.equal(toolUse("read", { path: "~/notes.md" }, env), undefined);
		assert.equal(toolUse("read", { path: "/work/app-two/a.ts" }, env), undefined, "a sibling that shares the name prefix is outside");
		assert.deepEqual(toolUse("read", { path: "/work/app/a.ts" }, env), { path: "/work/app/a.ts", use: "read" });
	});

	it("ignores the working directory itself", () => {
		assert.equal(toolUse("read", { path: "." }, env), undefined);
	});

	it("ignores a path a Placeholder cannot carry", () => {
		assert.equal(toolUse("read", { path: "odd]name.ts" }, env), undefined);
		assert.equal(toolUse("read", { path: 'odd"name.ts' }, env), undefined);
		assert.equal(toolUse("read", { path: "odd\nname.ts" }, env), undefined);
	});
});

describe("messagePaths", () => {
	it("finds @path tokens, wherever the file is", () => {
		assert.deepEqual(messagePaths("look at @src/api.ts and @../other/b.md, then @/etc/hosts.", env), [
			"/work/app/src/api.ts",
			"/work/other/b.md",
			"/etc/hosts",
		]);
	});

	it("reads a quoted @path with spaces", () => {
		assert.deepEqual(messagePaths('see @"my dir/a b.ts" please', env), ["/work/app/my dir/a b.ts"]);
	});

	it("does not take an @ inside a word, such as an e-mail address", () => {
		assert.deepEqual(messagePaths("mail me@example.com or @", env), []);
	});

	it("finds a command-line <file name> path at the start of a line", () => {
		assert.deepEqual(messagePaths('<file name="/work/app/README.md">\nhello\n</file>\nand <file name="/x/y.txt"> inline', env), ["/work/app/README.md"]);
	});

	it("leaves out pi's own temporary files, such as a pasted clipboard image", () => {
		assert.deepEqual(messagePaths("see @/tmp/pi-clipboard-1234.png and @/tmp/mine.png", env), ["/tmp/mine.png"]);
	});

	it("does not read the file contents that Context blocks carry at the end of the message", () => {
		const block = contextBlock({ name: "api", kind: "file", path: "src/api.ts", body: 'import x from @pkg/x\n<file name="/x/y">\n' });
		assert.deepEqual(messagePaths(`see @src/a.ts\n\n${block}`, env), ["/work/app/src/a.ts"]);
	});

	it("lists a path once", () => {
		assert.deepEqual(messagePaths("@a.ts @a.ts", env), ["/work/app/a.ts"]);
	});
});

describe("the store", () => {
	it("merges reads and edits of one file into one entry, newest use first", () => {
		const store = createUsedFiles();
		store.record("/work/app/a.ts", "read", 1000);
		store.record("/work/app/b.ts", "read", 2000);
		store.record("/work/app/a.ts", "edit", 3000);
		assert.deepEqual(store.files(), [
			{ path: "/work/app/a.ts", use: "edit", at: 3000 },
			{ path: "/work/app/b.ts", use: "read", at: 2000 },
		]);
	});

	it("reports the later use when a file is edited and then read", () => {
		const store = createUsedFiles();
		store.record("/work/app/a.ts", "edit", 1000);
		store.record("/work/app/a.ts", "read", 2000);
		assert.deepEqual(store.files(), [{ path: "/work/app/a.ts", use: "read", at: 2000 }]);
	});

	it("does not move a file back in time when an older use arrives later", () => {
		const store = createUsedFiles();
		store.record("/work/app/a.ts", "read", 2000);
		store.record("/work/app/a.ts", "read", 1000);
		assert.equal(store.files()[0]?.at, 2000);
	});

	it("breaks a tie by taking the edit, then the later arrival", () => {
		const store = createUsedFiles();
		store.record("/work/app/a.ts", "read", 1000);
		store.record("/work/app/a.ts", "edit", 1000);
		store.record("/work/app/b.ts", "read", 1000);
		assert.deepEqual(
			store.files().map((file) => [file.path, file.use]),
			[
				["/work/app/b.ts", "read"],
				["/work/app/a.ts", "edit"],
			],
		);
	});

	it("keeps at most MAX_RECENT files and drops the oldest", () => {
		assert.equal(MAX_RECENT, 200);
		const store = createUsedFiles();
		for (let index = 0; index < MAX_RECENT + 5; index++) store.record(`/work/app/f${index}.ts`, "read", 1000 + index);
		const files = store.files();
		assert.equal(files.length, MAX_RECENT);
		assert.equal(files[0]?.path, `/work/app/f${MAX_RECENT + 4}.ts`);
		assert.equal(files.at(-1)?.path, "/work/app/f5.ts");
		assert.equal(store.has("/work/app/f0.ts"), false);
		assert.equal(store.has("/work/app/f5.ts"), true);
	});

	it("is rebuilt from scratch, so rebuilding twice gives the same set", () => {
		const store = createUsedFiles();
		store.record("/work/app/old.ts", "read", 1);
		const uses = [
			{ path: "/work/app/a.ts", use: "read" as const, at: 10 },
			{ path: "/work/app/a.ts", use: "edit" as const, at: 20 },
		];
		store.rebuild(uses);
		const once = store.files();
		store.rebuild(uses);
		assert.deepEqual(store.files(), once);
		assert.deepEqual(once, [{ path: "/work/app/a.ts", use: "edit", at: 20 }]);
		assert.equal(store.has("/work/app/old.ts"), false);
	});

	it("skips a use without a usable time", () => {
		const store = createUsedFiles();
		store.record("/work/app/a.ts", "read", Number.NaN);
		assert.deepEqual(store.files(), []);
	});
});

describe("paths in a row and in a Placeholder", () => {
	it("shows a path inside the working directory relative to it, a path under home with ~, anything else absolute", () => {
		assert.equal(rowPath("/work/app/src/a.ts", env), "src/a.ts");
		assert.equal(rowPath("/work/app/README.md", env), "README.md");
		assert.equal(rowPath("/home/me/notes/a.md", env), "~/notes/a.md");
		assert.equal(rowPath("/etc/hosts", env), "/etc/hosts");
		assert.equal(rowPath("/work/app-two/a.ts", env), "/work/app-two/a.ts");
	});

	it("puts ./ in front of a root file so every Placeholder path has a /", () => {
		assert.equal(placeholderTarget("/work/app/README.md", env), "./README.md");
		assert.equal(placeholderTarget("/work/app/src/a.ts", env), "src/a.ts");
		assert.equal(placeholderTarget("/home/me/a.md", env), "~/a.md");
		assert.equal(placeholderTarget("/etc/hosts", env), "/etc/hosts");
	});

	it("quotes a path that has spaces", () => {
		assert.equal(placeholderTarget("/work/app/my dir/a b.ts", env), '"my dir/a b.ts"');
		assert.equal(placeholderTarget("/work/app/a b.ts", env), '"./a b.ts"');
	});

	it("reads a Placeholder target back, quotes removed", () => {
		assert.deepEqual(parseRecentTarget("src/a.ts"), { form: "path", path: "src/a.ts" });
		assert.deepEqual(parseRecentTarget('"my dir/a b.ts"'), { form: "path", path: "my dir/a b.ts" });
		assert.deepEqual(parseRecentTarget("file:src/a.ts"), { form: "file", path: "src/a.ts" });
		assert.deepEqual(parseRecentTarget('file:"my dir/a b.ts"'), { form: "file", path: "my dir/a b.ts" });
		assert.deepEqual(parseRecentTarget("file:./README.md"), { form: "file", path: "./README.md" });
	});

	it("leaves a target that is a Ref name (no /) and an empty file path alone", () => {
		assert.equal(parseRecentTarget("api"), undefined);
		assert.equal(parseRecentTarget("tag"), undefined);
		assert.equal(parseRecentTarget("file:"), undefined);
		assert.equal(parseRecentTarget('file:""'), undefined);
	});
});

describe("matchRecent", () => {
	const store = createUsedFiles();
	store.record("/work/app/src/api.ts", "read", 3000);
	store.record("/work/app/README.md", "edit", 2000);
	store.record("/home/me/notes/Api-notes.md", "read", 1000);
	const files = store.files();

	it("returns every file, newest first, for a bare query", () => {
		assert.deepEqual(
			matchRecent(files, "", env).map((file) => file.path),
			["/work/app/src/api.ts", "/work/app/README.md", "/home/me/notes/Api-notes.md"],
		);
	});

	it("keeps the files whose shown path contains the query, ignoring case, in the same order", () => {
		assert.deepEqual(
			matchRecent(files, "API", env).map((file) => file.path),
			["/work/app/src/api.ts", "/home/me/notes/Api-notes.md"],
		);
		assert.deepEqual(
			matchRecent(files, "src/api.ts", env).map((file) => file.path),
			["/work/app/src/api.ts"],
		);
	});

	it("also matches the path as the Placeholder writes it", () => {
		assert.deepEqual(
			matchRecent(files, "./readme", env).map((file) => file.path),
			["/work/app/README.md"],
		);
	});

	it("gives nothing when no path contains the query", () => {
		assert.deepEqual(matchRecent(files, "zzz", env), []);
	});
});

describe("ageNote", () => {
	const at = 1_000_000_000_000;
	const note = (use: "read" | "edit", ago: number) => ageNote({ path: "/x", use, at }, at + ago);
	const MINUTE = 60_000;

	it("says edited or read and how long ago", () => {
		assert.equal(note("edit", 5 * MINUTE), "edited 5 min ago");
		assert.equal(note("read", 3 * 60 * MINUTE), "read 3 h ago");
		assert.equal(note("read", 2 * 24 * 60 * MINUTE), "read 2 d ago");
	});

	it("says just now under a minute, and for a clock that is behind", () => {
		assert.equal(note("edit", 59_000), "edited just now");
		assert.equal(note("edit", -5000), "edited just now");
	});
});

describe("isUsedProjectFile", () => {
	const store = createUsedFiles();
	for (const path of ["/work/app/src/a.ts", "/work/app/link.ts", "/work/app/gone.ts", "/outside/b.ts", "/work/app/dir-link/c.ts"])
		store.record(path, "read", 1);
	const real: Record<string, string> = {
		"/work/app": "/real/app",
		"/work/app/src/a.ts": "/real/app/src/a.ts",
		"/work/app/link.ts": "/real/secret/key.pem",
		"/outside/b.ts": "/outside/b.ts",
		"/work/app/dir-link/c.ts": "/real/elsewhere/c.ts",
	};
	const realpath = (path: string) => real[path];
	const allowed = (path: string) => isUsedProjectFile(path, "/work/app", store, realpath);

	it("accepts a file the session used that stays inside the working directory after following symlinks", () => {
		assert.equal(allowed("/work/app/src/a.ts"), true);
	});

	it("refuses a file nothing in the session used", () => {
		assert.equal(allowed("/work/app/src/other.ts"), false);
		assert.equal(allowed("/work/app/.env"), false);
	});

	it("refuses a used file outside the working directory", () => {
		assert.equal(allowed("/outside/b.ts"), false);
	});

	it("refuses a used file or directory that is a symlink out of the working directory", () => {
		assert.equal(allowed("/work/app/link.ts"), false);
		assert.equal(allowed("/work/app/dir-link/c.ts"), false);
	});

	it("accepts a used file that no longer exists, since nothing can be read through it", () => {
		assert.equal(allowed("/work/app/gone.ts"), true);
	});
});
