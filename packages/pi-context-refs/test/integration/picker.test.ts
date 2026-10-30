// The # picker (DESIGN.md sections 4 and 7): the extension is loaded into the fake host the way pi loads it, its autocomplete
// provider is stacked on a stand-in `#` provider as pi stacks them, and a real pi-tui Editor is fed key bytes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { EditorHarness } from "../support/editor-harness.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { initRepo } from "../support/git-repo.ts";
import { issuesProvider } from "../support/probe-autocomplete.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const ISSUES = ["#42 crash on start", "#123 slow picker"];
const TAB = "\t";
const BACKSPACE = "\x7f";
const ROW_MARKS = /[◆■●○⧉]/u;

let root = "";
let agentDir = "";
let project = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "context-refs-picker-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const libraryFile = () => join(agentDir, "pi-context-refs.json");
const writeLibrary = (refs: unknown[], settings: Record<string, unknown> = {}) =>
	writeFileSync(libraryFile(), JSON.stringify({ version: 1, $schema: "x", ...settings, refs }));
const snippet = (name: string, text: string, extra: Record<string, unknown> = {}) => ({ name, kind: "snippet", text, ...extra });
const file = (name: string, path: string, extra: Record<string, unknown> = {}) => ({ name, kind: "file", path, ...extra });

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

/** A TUI session started in `cwd`. The editor's autocomplete chain is the stand-in issues provider with the package's picker on top of it, as pi stacks them. */
async function start(cwd = project, options: { trusted?: boolean } = {}) {
	const host = await boot();
	const session = createFakeSession({ cwd, mode: "tui", ...options });
	await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
	const editor = () => new EditorHarness([issuesProvider(ISSUES), ...session.autocompleteProviders], cwd);
	return { host, session, editor };
}

/** The lines of the open list that carry a layer mark. */
const rowsOf = (screen: string): string[] => screen.split("\n").filter((line) => ROW_MARKS.test(line));

const sampleLibrary = () =>
	writeLibrary([
		snippet("terse", "Be brief.", { description: "Keep answers short", tags: ["style"] }),
		snippet("rules", "Follow the rules.", { tags: ["style", "team"] }),
		file("agents", "AGENTS.md", { description: "Repository rules" }),
		file("mine", "notes.md", { description: "Only for this project", scope: { path: project } }),
		file("elsewhere", "x.md", { scope: { path: join(root, "somewhere-else") } }),
	]);

describe("the # picker", () => {
	it("opens on a bare #, scoped rows first, each with a mark, name, kind and description", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("#");
		assert.ok(picker.listOpen);
		const rows = rowsOf(picker.screen);
		assert.match(rows[0] ?? "", /◆ mine\s+file · Only for this project/);
		assert.match(rows[1] ?? "", /● terse\s+snippet · Keep answers short/);
		assert.match(rows[2] ?? "", /● rules\s+snippet · "Follow the rules\."/, "a Ref with no description shows its target");
		assert.match(rows[3] ?? "", /● agents\s+file · Repository rules/);
		assert.doesNotMatch(picker.screen, /elsewhere/, "a Scoped Ref for another place is not Visible");
	});

	it("keeps global, Built-in and Bundle rows in that order, and marks the Built-in Refs", async () => {
		writeLibrary([snippet("start", "x", { tags: ["standard"] })]);
		initRepo(project);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#sta");
		const rows = rowsOf(picker.screen);
		assert.equal(rows.length, 4, picker.screen);
		assert.match(rows[0] ?? "", /● start\s+snippet · "x"/);
		assert.match(rows[1] ?? "", /○ staged\s+dynamic · built-in · Staged changes/);
		assert.match(rows[2] ?? "", /○ status\s+dynamic · built-in · Changed files/);
		assert.match(rows[3] ?? "", /⧉ tag:standard\s+bundle · 1 Ref: start/);
	});

	it("shows Project library Refs with the project mark, between scoped and global ones", async () => {
		sampleLibrary();
		mkdirSync(join(project, ".pi"));
		writeFileSync(
			join(project, ".pi", "pi-context-refs.json"),
			JSON.stringify({ version: 1, refs: [snippet("deploy", "Run ./deploy", { description: "Team deploy steps" })] }),
		);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#");
		const rows = rowsOf(picker.screen);
		assert.match(rows[0] ?? "", /◆ mine/);
		assert.match(rows[1] ?? "", /■ deploy\s+snippet · Team deploy steps/);
		assert.match(rows[2] ?? "", /● terse/);
	});

	it("leaves Project Refs out of an untrusted project", async () => {
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "pi-context-refs.json"), JSON.stringify({ version: 1, refs: [snippet("deploy", "x")] }));
		writeLibrary([snippet("terse", "x")]);
		const { editor } = await start(project, { trusted: false });
		const picker = editor();
		await picker.type("#");
		assert.doesNotMatch(picker.screen, /deploy/);
		assert.match(picker.screen, /terse/);
	});

	it("narrows as the token grows and claims #text only while a row matches", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("#ag");
		assert.ok(picker.listOpen);
		assert.match(picker.screen, /agents/);
		assert.doesNotMatch(picker.screen, /terse/);
		await picker.type("x");
		assert.equal(picker.listOpen, false, "nothing matches #agx and no other provider claims it");
		assert.equal(picker.text, "#agx");
	});

	it("matches a Ref by its Tag", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("#team");
		assert.match(picker.screen, /rules/);
		assert.match(picker.screen, /tag:team/);
		assert.doesNotMatch(picker.screen, /terse/);
	});

	it("falls a numeric token through to the provider registered before it, even when a Ref has a number for a name", async () => {
		writeLibrary([snippet("1", "one"), snippet("42", "answer")]);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#4");
		assert.ok(picker.listOpen);
		assert.match(picker.screen, /#42 crash on start/);
		assert.doesNotMatch(picker.screen, /snippet/);
	});

	it("falls an unmatched token through, and closes the list when nobody claims it", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("#zzz");
		assert.equal(picker.listOpen, false);
		assert.equal(picker.text, "#zzz");
	});

	it("opens nothing for # followed by a space, so a Markdown heading is left alone", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("# heading");
		assert.equal(picker.listOpen, false);
		assert.equal(picker.text, "# heading");
	});

	it("replaces the typed token with the Placeholder when a row is picked", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("see #ag");
		await picker.press(TAB);
		assert.equal(picker.text, "see [ref:agents]");
		assert.equal(picker.listOpen, false);
	});

	it("inserts a Placeholder from a bare # with Enter", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#");
		await picker.press("\r");
		assert.equal(picker.text, "[ref:terse]");
	});

	it("still hands another provider's pick to that provider", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("#4");
		await picker.press(TAB);
		assert.equal(picker.text, "#42 crash on start");
	});

	it("inserts one Placeholder per member when a Bundle is picked", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("#tag:sty");
		assert.match(picker.screen, /⧉ tag:style\s+bundle · 2 Refs: terse, rules/);
		await picker.press(TAB);
		assert.equal(picker.text, "[ref:terse] [ref:rules]");
	});

	it("inserts only the Bundle members the draft does not already have", async () => {
		sampleLibrary();
		const { editor } = await start();
		const picker = editor();
		await picker.type("[ref:rules] and #tag:sty");
		await picker.press(TAB);
		assert.equal(picker.text, "[ref:rules] and [ref:terse]");
	});

	it("shows the Built-in Refs in a git work tree and hides them outside one", async () => {
		writeLibrary([snippet("terse", "x")]);
		const outside = await start();
		const bare = outside.editor();
		await bare.type("#");
		assert.doesNotMatch(bare.screen, /diff|staged|status|built-in/);
		await bare.type("lo");
		assert.equal(bare.listOpen, false, "#lo matches no row outside a repository");

		initRepo(project);
		const inside = await start();
		const repo = inside.editor();
		await repo.type("#lo");
		assert.ok(repo.listOpen);
		assert.match(repo.screen, /○ log\s+dynamic · built-in · The last 20 commits/);
	});

	it("keeps a saved Ref that shadows a Built-in Ref, in or out of a work tree", async () => {
		writeLibrary([snippet("log", "my log")]);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#lo");
		assert.match(picker.screen, /● log\s+snippet/);
		assert.doesNotMatch(picker.screen, /built-in/);
	});

	it("hides Built-in Refs that the builtins setting turns off", async () => {
		initRepo(project);
		writeLibrary([snippet("terse", "x")], { builtins: ["log"] });
		const { editor } = await start();
		const picker = editor();
		await picker.type("#lo");
		assert.equal(picker.listOpen, false);
		await picker.type(BACKSPACE.repeat(2));
		await picker.type("st");
		assert.match(picker.screen, /○ staged/);
	});

	it("re-reads the library file while the list is open", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#");
		assert.doesNotMatch(picker.screen, /newly/);
		writeLibrary([snippet("terse", "x"), snippet("newly-added", "y")]);
		await picker.type("n");
		assert.match(picker.screen, /newly-added/);
	});

	it("leaves the token to the next provider when the library cannot be read", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { editor } = await start();
		rmSync(libraryFile());
		mkdirSync(libraryFile());
		const picker = editor();
		await picker.type("#te");
		assert.equal(picker.listOpen, false, "the library is unreadable and the stand-in provider has no row for #te");
		await picker.type(`${BACKSPACE.repeat(2)}4`);
		assert.match(picker.screen, /#42 crash on start/);
	});

	it("starts with the default Trigger when the library cannot be read at session start", async () => {
		mkdirSync(libraryFile());
		initRepo(project);
		const { editor } = await start();
		const picker = editor();
		await picker.type("#lo");
		assert.match(picker.screen, /○ log/);
	});

	it("offers nothing after the session has shut down", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { editor, host, session } = await start();
		await host.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);
		const picker = editor();
		await picker.type("#te");
		assert.equal(picker.listOpen, false);
	});

	it("adds no provider outside the TUI", async () => {
		writeLibrary([snippet("terse", "x")]);
		const host = await boot();
		for (const mode of ["print", "json"] as const) {
			const session = createFakeSession({ cwd: project, mode });
			await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
			assert.equal(session.autocompleteProviders.length, 0, mode);
		}
	});
});

describe("the trigger setting", () => {
	it("moves the picker to another character", async () => {
		writeLibrary([snippet("terse", "x")], { trigger: "$" });
		const { editor, session } = await start();
		assert.equal(session.notices.length, 0);
		const picker = editor();
		await picker.type("see $te");
		assert.match(picker.screen, /terse/);
		await picker.press(TAB);
		assert.equal(picker.text, "see [ref:terse]");
		const other = editor();
		await other.type("#te");
		assert.equal(other.listOpen, false, "# is no longer the Trigger");
	});

	it("keeps the Trigger a session started with until /reload, even if the file changes", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { editor } = await start();
		writeLibrary([snippet("terse", "x")], { trigger: "$" });
		const picker = editor();
		await picker.type("#te");
		assert.match(picker.screen, /terse/);
		const other = editor();
		await other.type("$te");
		assert.equal(other.listOpen, false);
	});

	it("picks up the new Trigger when the session starts again, as after /reload", async () => {
		writeLibrary([snippet("terse", "x")]);
		await start();
		writeLibrary([snippet("terse", "x")], { trigger: "%" });
		const reloaded = await start();
		const picker = reloaded.editor();
		await picker.type("%");
		assert.match(picker.screen, /terse/);
	});

	for (const trigger of ["/", "@", "!", " ", "##"]) {
		it(`reports ${JSON.stringify(trigger)} as a config error and keeps #`, async () => {
			writeLibrary([snippet("terse", "x")], { trigger });
			const { editor, session } = await start();
			assert.equal(session.notices.length, 1);
			assert.equal(session.notices[0]?.type, "warning");
			assert.match(session.notices[0]?.message ?? "", /^pi-context-refs: trigger .*; using "#"$/);
			const picker = editor();
			await picker.type("#te");
			assert.match(picker.screen, /terse/);
		});
	}
});
