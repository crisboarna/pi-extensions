// Recent refs (DESIGN.md section 11): the extension is loaded into the fake host the way pi loads it, scripted tool results, inputs and session
// events feed it, the `#` picker is driven with a real pi-tui Editor, and the Placeholders it inserts go back through the `input` handler.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { EditorHarness } from "../support/editor-harness.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { issuesProvider } from "../support/probe-autocomplete.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const TAB = "\t";
const MINUTE = 60_000;

let root = "";
let agentDir = "";
let project = "";
let outside = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "context-refs-recent-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	outside = join(root, "outside");
	for (const dir of [agentDir, join(project, "src"), outside]) mkdirSync(dir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const [name, text] of [
		["src/api.ts", "export const api = 1;\n"],
		["src/util.ts", "export const util = 2;\n"],
		["README.md", "# readme\n"],
		[".env", "SECRET=1\n"],
	] as const) {
		writeFileSync(join(project, name), text);
	}
	writeFileSync(join(outside, "key.pem"), "PRIVATE KEY\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

type Branch = unknown[];

/** A session in `cwd` whose branch is `branch.current`, started the way pi starts one. */
async function start(options: { mode?: "tui" | "print"; branch?: Branch; cwd?: string } = {}) {
	const host = await boot();
	const cwd = options.cwd ?? project;
	const session = createFakeSession({ cwd, mode: options.mode ?? "tui" });
	const branch = { current: options.branch ?? [] };
	session.ctx.sessionManager = { getBranch: () => branch.current };
	await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
	const result = (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		host.fire(
			"tool_result",
			{ type: "tool_result", toolName, toolCallId: "call-1", input, content: [], isError: false, details: undefined, ...extra },
			session.ctx,
		);
	const send = (text: string, extra: Record<string, unknown> = {}) =>
		host.fire("input", { type: "input", text, source: "interactive", ...extra }, session.ctx);
	const editor = () => new EditorHarness([issuesProvider(["#42 crash on start"]), ...session.autocompleteProviders], cwd);
	/** The Recent rows (lines with the ↺ mark) of the list opened by `#query`. */
	const recentRows = async (query = ""): Promise<string[]> => {
		const picker = editor();
		await picker.type(`#${query}`);
		return picker.screen.split("\n").filter((line) => line.includes("↺"));
	};
	/** What the package's provider offers for `#query`, read straight from it: the editor's list shows only a few rows at a time. */
	const items = async (query = "") => {
		const provider = session.autocompleteProviders[0]?.(new CombinedAutocompleteProvider([], cwd));
		const suggestions = await provider?.getSuggestions([`#${query}`], 0, query.length + 1, { signal: new AbortController().signal });
		return (suggestions?.items ?? []).filter((item) => item.value.startsWith("pi-context-refs:recent:"));
	};
	return { host, session, branch, result, send, editor, recentRows, items };
}

const message = (role: string, extra: Record<string, unknown>, at: number) => ({
	type: "message",
	id: `e${at}`,
	parentId: null,
	timestamp: new Date(at).toISOString(),
	message: { role, timestamp: at, ...extra },
});
const assistantCall = (id: string, name: string, args: Record<string, unknown>, at: number) =>
	message("assistant", { content: [{ type: "toolCall", id, name, arguments: args }] }, at);
const toolResult = (id: string, name: string, at: number, extra: Record<string, unknown> = {}) =>
	message("toolResult", { toolCallId: id, toolName: name, content: [], isError: false, ...extra }, at);
const user = (content: unknown, at: number) => message("user", { content }, at);

describe("what counts as a Recent ref (tool results)", () => {
	it("lists a file after a successful read, edit or write, one row per file with read and edit merged", async () => {
		const { result, recentRows } = await start();
		await result("read", { path: "src/api.ts" });
		await result("write", { path: "notes.md", content: "x" });
		await result("edit", { path: "@src/api.ts", edits: [] });
		await result("read", { path: "README.md" });
		writeFileSync(join(project, "notes.md"), "x");
		const rows = await recentRows();
		assert.equal(rows.length, 3, rows.join("\n"));
		assert.match(rows[0] ?? "", /↺ README\.md\s+recent · read just now/);
		assert.match(rows[1] ?? "", /↺ src\/api\.ts\s+recent · edited just now/, "the edit merged with the earlier read");
		assert.match(rows[2] ?? "", /↺ notes\.md\s+recent · edited just now/);
	});

	it("ignores failed calls and every tool but read, edit and write", async () => {
		const { result, recentRows } = await start();
		await result("read", { path: "src/api.ts" }, { isError: true });
		await result("edit", { path: "src/util.ts" }, { isError: true });
		for (const name of ["ls", "find", "grep", "bash", "mcp__fs__read_file", "fetch_content"]) await result(name, { path: "README.md" });
		await result("bash", { command: "cat README.md" });
		assert.deepEqual(await recentRows(), []);
	});

	it("ignores a call whose path is invalid or outside the session directory", async () => {
		const { result, recentRows } = await start();
		await result("read", {});
		await result("read", { path: 7 });
		await result("read", { path: join(outside, "key.pem") });
		await result("read", { path: "../outside/key.pem" });
		await result("read", { path: "~/.bashrc" });
		assert.deepEqual(await recentRows(), []);
	});

	it("counts the calls of a codemode script that succeeded, not the failed ones, and not the codemode result itself", async () => {
		const { result, recentRows } = await start();
		await result("read", { path: "src/api.ts" }, { toolCallId: "call-1/1", parentToolCallId: "call-1" });
		await result("read", { path: "src/util.ts" }, { toolCallId: "call-1/2", parentToolCallId: "call-1", isError: true });
		await result("codemode", { code: 'await tools.read({ path: "README.md" })' }, { toolCallId: "call-1" });
		const rows = await recentRows();
		assert.equal(rows.length, 1, rows.join("\n"));
		assert.match(rows[0] ?? "", /src\/api\.ts/);
	});
});

describe("what counts as a Recent ref (sent messages)", () => {
	it("notes an @path token, wherever the file is", async () => {
		const { send, items } = await start();
		await send(`compare @src/api.ts with @"${join(outside, "key.pem")}"`);
		assert.deepEqual(
			(await items()).map((item) => item.label),
			["↺ src/api.ts", `↺ ${join(outside, "key.pem")}`].sort(),
		);
	});

	it("notes the path of a command-line <file name> block", async () => {
		const { send, recentRows } = await start();
		await send(`<file name="${join(project, "README.md")}">\n# readme\n</file>\nsummarize it`);
		assert.match((await recentRows()).join("\n"), /↺ README\.md/);
	});

	it("ignores a message sent by an extension, and pi's clipboard and temporary files", async () => {
		const { send, recentRows } = await start();
		await send("@src/api.ts", { source: "extension" });
		const temporary = join(mkdtempSync(join(tmpdir(), "context-refs-clipboard-")), "pi-clipboard-0000.png");
		writeFileSync(temporary, "png");
		try {
			await send(`look at @${temporary}`);
			assert.deepEqual(await recentRows(), []);
		} finally {
			rmSync(dirname(temporary), { recursive: true, force: true });
		}
	});

	it("does not take the file contents that a sent message carries in its Context blocks", async () => {
		const { send, recentRows } = await start();
		await send('see [ref:src/api.ts]\n\n<context-ref name="x" kind="file" path="x.txt" bytes="17">\nmail @src/util.ts\n</context-ref>');
		assert.deepEqual(await recentRows(), []);
	});
});

describe("the session's branch", () => {
	const NOW = Date.now();
	const branch = (): Branch => [
		user("start with @README.md", NOW - 30 * MINUTE),
		assistantCall("c1", "read", { path: "src/api.ts" }, NOW - 20 * MINUTE),
		toolResult("c1", "read", NOW - 20 * MINUTE),
		assistantCall("c2", "edit", { path: "src/api.ts", edits: [] }, NOW - 10 * MINUTE),
		toolResult("c2", "edit", NOW - 10 * MINUTE),
		assistantCall("c3", "read", { path: "src/util.ts" }, NOW - 5 * MINUTE),
		toolResult("c3", "read", NOW - 5 * MINUTE, { isError: true }),
		assistantCall("c4", "grep", { path: "src" }, NOW - 4 * MINUTE),
		toolResult("c4", "grep", NOW - 4 * MINUTE),
		assistantCall("c5", "codemode", { code: "..." }, NOW - 3 * MINUTE),
		toolResult("c5", "codemode", NOW - 3 * MINUTE, {
			nestedCalls: {
				complete: true,
				calls: [
					{ id: "c5/1", name: "write", arguments: { path: "made.txt" }, status: "ok" },
					{ id: "c5/2", name: "read", arguments: { path: "src/util.ts" }, status: "error" },
					{ id: "c5/3", name: "read", arguments: { path: ".env" }, status: "unfinished" },
					{ id: "c5/4", name: "read", argumentsBytes: 99999, status: "ok" },
				],
			},
		}),
		user(
			[
				{ type: "text", text: "and <context-ref> mail @src/util.ts" },
				{ type: "image", data: "", mimeType: "image/png" },
			],
			NOW - 2 * MINUTE,
		),
	];

	it("is read at session start: successful calls, nested calls with status ok and @path tokens, with their stored times", async () => {
		writeFileSync(join(project, "made.txt"), "m");
		const { recentRows } = await start({ branch: branch() });
		const rows = await recentRows();
		assert.equal(rows.length, 4, rows.join("\n"));
		assert.match(rows[0] ?? "", /↺ src\/util\.ts\s+recent · read 2 min ago/);
		assert.match(rows[1] ?? "", /↺ made\.txt\s+recent · edited 3 min ago/);
		assert.match(rows[2] ?? "", /↺ src\/api\.ts\s+recent · edited 10 min ago/);
		assert.match(rows[3] ?? "", /↺ README\.md\s+recent · read 30 min ago/);
	});

	it("is rebuilt at session_tree to the new branch, and rebuilding twice gives the same rows", async () => {
		const { host, session, branch: current, recentRows } = await start({ branch: branch() });
		const before = await recentRows();
		await host.fire("session_tree", { type: "session_tree", newLeafId: "x", oldLeafId: "y" }, session.ctx);
		await host.fire("session_tree", { type: "session_tree", newLeafId: "x", oldLeafId: "y" }, session.ctx);
		assert.deepEqual(await recentRows(), before);
		current.current = [assistantCall("n1", "read", { path: "src/util.ts" }, NOW), toolResult("n1", "read", NOW)];
		await host.fire("session_tree", { type: "session_tree", newLeafId: "z", oldLeafId: "x" }, session.ctx);
		const after = await recentRows();
		assert.equal(after.length, 1, after.join("\n"));
		assert.match(after[0] ?? "", /src\/util\.ts/);
	});

	it("is rebuilt at a new session_start, so an earlier session's files are gone", async () => {
		const { host, session, branch: current, result, recentRows } = await start({ branch: branch() });
		await result("read", { path: "src/util.ts" });
		current.current = [];
		await host.fire("session_start", { type: "session_start", reason: "new" }, session.ctx);
		assert.deepEqual(await recentRows(), []);
	});

	it("is forgotten at session_shutdown", async () => {
		const { host, session, recentRows } = await start({ branch: branch() });
		await host.fire("session_shutdown", { type: "session_shutdown" }, session.ctx);
		assert.deepEqual(await recentRows(), []);
	});

	it("keeps live updates after a rebuild", async () => {
		const { result, recentRows } = await start({ branch: branch() });
		await result("read", { path: "README.md" });
		assert.match((await recentRows())[0] ?? "", /↺ README\.md\s+recent · read just now/);
	});

	it("starts empty when the branch cannot be read", async () => {
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		session.ctx.sessionManager = {
			getBranch: () => {
				throw new Error("no branch");
			},
		};
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		await host.fire(
			"tool_result",
			{ type: "tool_result", toolName: "read", toolCallId: "c", input: { path: "README.md" }, content: [], isError: false },
			session.ctx,
		);
		const picker = new EditorHarness(session.autocompleteProviders, project);
		await picker.type("#");
		assert.match(picker.screen, /↺ README\.md/);
	});

	it("writes nothing to disk", async () => {
		const files = () => [readdirSync(agentDir), readdirSync(project, { recursive: true }), readdirSync(outside)];
		const before = files();
		const { result, send, recentRows } = await start({ branch: branch() });
		await result("read", { path: "src/api.ts" });
		await send("see @README.md [ref:file:src/api.ts]");
		await recentRows();
		assert.deepEqual(files(), before);
	});
});

describe("the Recent section of the # picker", () => {
	it("sits below the saved Refs and above the Bundles", async () => {
		writeFileSync(
			join(agentDir, "pi-context-refs.json"),
			JSON.stringify({ version: 1, refs: [{ name: "terse", kind: "snippet", text: "x", tags: ["style"] }] }),
		);
		const { result, editor } = await start();
		await result("read", { path: "src/api.ts" });
		const picker = editor();
		await picker.type("#");
		const rows = picker.screen.split("\n").filter((line) => /[●↺⧉]/u.test(line));
		assert.match(rows[0] ?? "", /● terse/);
		assert.match(rows[1] ?? "", /↺ src\/api\.ts/);
		assert.match(rows[2] ?? "", /⧉ tag:style/);
	});

	it("shows the 10 newest on a bare Trigger and searches all of them for a query", async () => {
		const { result, items } = await start();
		for (let index = 0; index < 12; index++) {
			writeFileSync(join(project, `f${index}.txt`), "x");
			await result("read", { path: `f${index}.txt` });
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const bare = (await items()).map((item) => item.label);
		assert.deepEqual(
			bare,
			Array.from({ length: 10 }, (_, index) => `↺ f${11 - index}.txt`),
		);
		assert.deepEqual(
			(await items(".txt")).map((item) => item.label),
			Array.from({ length: 12 }, (_, index) => `↺ f${11 - index}.txt`),
		);
		assert.deepEqual(
			(await items("f0")).map((item) => item.label),
			["↺ f0.txt"],
		);
	});

	it("hides a file that is gone and the target of a saved Ref", async () => {
		writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs: [{ name: "agents", kind: "file", path: "README.md" }] }));
		const { result, recentRows } = await start();
		await result("read", { path: "src/api.ts" });
		await result("read", { path: "README.md" });
		await result("read", { path: "src/gone.ts" });
		const rows = await recentRows();
		assert.equal(rows.length, 1, rows.join("\n"));
		assert.match(rows[0] ?? "", /src\/api\.ts/);
	});

	it("inserts a path Placeholder on a pick: relative inside, ./ for a root file, quoted with spaces", async () => {
		mkdirSync(join(project, "my dir"));
		writeFileSync(join(project, "my dir", "a b.ts"), "x");
		const { result, editor } = await start();
		for (const path of ["README.md", "my dir/a b.ts", "src/api.ts"]) {
			await result("read", { path });
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const picked: string[] = [];
		for (const query of ["READ", "my", "src/a"]) {
			const picker = editor();
			await picker.type(`see #${query}`);
			await picker.press(TAB);
			picked.push(picker.text);
		}
		assert.deepEqual(picked, ["see [ref:./README.md]", 'see [ref:"my dir/a b.ts"]', "see [ref:src/api.ts]"]);
	});

	it("claims a typed #src/api while a Recent row matches, and lets the token go once none does", async () => {
		const { result, editor } = await start();
		await result("read", { path: "src/api.ts" });
		const picker = editor();
		await picker.type("#src/api");
		assert.ok(picker.listOpen);
		assert.match(picker.screen, /↺ src\/api\.ts/);
		await picker.type(".tsx");
		assert.equal(picker.listOpen, false);
		assert.equal(picker.text, "#src/api.tsx");
	});

	it("leaves a numeric token to the other provider", async () => {
		const { result, editor } = await start();
		await result("read", { path: "src/api.ts" });
		const picker = editor();
		await picker.type("#4");
		assert.match(picker.screen, /#42 crash on start/);
		assert.doesNotMatch(picker.screen, /↺/);
	});
});

describe("expanding the Placeholders", () => {
	for (const mode of ["tui", "print"] as const) {
		it(`prints the path for [ref:<path>] in ${mode} mode, whether or not the session used the file`, async () => {
			const { send } = await start({ mode });
			const result = await send("see [ref:src/api.ts], [ref:./README.md], [ref:/etc/hosts] and [ref:~/x.md]");
			assert.deepEqual(result, { action: "transform", text: `see src/api.ts, README.md, /etc/hosts and ${join(homedir(), "x.md")}` });
		});
	}

	it("never expands a typed #src/api.ts, even for a file the session used", async () => {
		const { result, send } = await start();
		await result("read", { path: "src/api.ts" });
		assert.equal(await send("see #src/api.ts and #./README.md"), undefined);
	});

	it("sends a used file as a Context block for [ref:file:<path>]", async () => {
		const { result, send } = await start();
		await result("read", { path: "src/api.ts" });
		const sent = await send("explain [ref:file:src/api.ts]");
		assert.deepEqual(sent, {
			action: "transform",
			text: 'explain [ref:file:src/api.ts]\n\n<context-ref name="src/api.ts" kind="file" path="src/api.ts" bytes="22">\nexport const api = 1;\n\n</context-ref>',
		});
	});

	it("sends a file the branch shows was used, after a rebuild", async () => {
		const at = Date.now();
		const { send } = await start({ branch: [assistantCall("c1", "read", { path: "README.md" }, at), toolResult("c1", "read", at)] });
		const sent = (await send("[ref:file:./README.md]")) as { text: string };
		assert.match(sent.text, /<context-ref name="\.\/README\.md" kind="file" path="README\.md" bytes="9">\n# readme\n\n<\/context-ref>/);
	});

	it("sends a file mentioned with @path in the same message", async () => {
		const { send } = await start();
		const sent = (await send("check @src/util.ts via [ref:file:src/util.ts]")) as { text: string };
		assert.match(sent.text, /name="src\/util\.ts"/);
	});

	it("leaves the Placeholder as typed, and reads nothing, for a file the session did not use", async () => {
		const { result, send } = await start();
		await result("read", { path: "src/api.ts" });
		assert.equal(await send("[ref:file:.env] [ref:file:src/util.ts] [ref:file:./.env]"), undefined);
	});

	it("leaves the Placeholder as typed for a used file that is a symlink out of the project", async () => {
		symlinkSync(join(outside, "key.pem"), join(project, "link.pem"));
		const { result, send } = await start();
		await result("read", { path: "link.pem" });
		assert.equal(await send("[ref:file:link.pem]"), undefined);
	});

	it("leaves the Placeholder as typed for a file outside the project that an @path token mentioned", async () => {
		const key = join(outside, "key.pem");
		const { send } = await start();
		assert.equal(await send(`look at @${key} and [ref:file:${key}]`), undefined);
	});

	it("reports a used file that was deleted since, as a Failure note in RPC-like modes and a cancelled send in the TUI", async () => {
		const { result, send, session } = await start();
		await result("write", { path: "tmp.txt", content: "x" });
		const sent = await send("[ref:file:tmp.txt]");
		assert.equal((sent as { action: string }).action, "handled");
		assert.deepEqual(session.editorTexts, ["[ref:file:tmp.txt]"]);
		assert.match(session.notices[0]?.message ?? "", /tmp\.txt does not exist/);
	});

	it("does not change a Placeholder that names a saved Ref", async () => {
		writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs: [{ name: "api", kind: "path", path: "docs/api.md" }] }));
		const { send } = await start();
		assert.deepEqual(await send("[ref:api]"), { action: "transform", text: "docs/api.md" });
	});
});
