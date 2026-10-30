// The alt+r overlay (DESIGN.md sections 7, 11 and 14): the extension is loaded into the fake host the way pi loads it, a real pi-tui editor sits in the
// editor slot (built from the factory the package installs) and is given the extension's shortcut the way pi's CustomEditor is, and the overlay is
// the package's own component fed key bytes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, KeybindingsManager, matchesKey, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import type { EditorFactory } from "../../src/pi/editor.ts";
import { createFakeHost, createFakeSession, type ShownComponent } from "../support/fake-pi.ts";
import { initRepo } from "../support/git-repo.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const KEYS = {
	alt_r: "\x1br",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	up: "\x1b[A",
	down: "\x1b[B",
	ctrlS: "\x13",
	ctrlE: "\x05",
	ctrlD: "\x04",
	backspace: "\x7f",
	left: "\x1b[D",
};

const identity = (text: string) => text;
const THEME = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
const FAKE_TUI = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as Parameters<EditorFactory>[2];

let root = "";
let agentDir = "";
let project = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "context-refs-overlay-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	for (const dir of [agentDir, join(project, "src")]) mkdirSync(dir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(project, "src", "api.ts"), "export const api = 1;\n");
	writeFileSync(join(project, "README.md"), "# readme\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const libraryFile = () => join(agentDir, "pi-context-refs.json");
const writeLibrary = (refs: unknown[], settings: Record<string, unknown> = {}) =>
	writeFileSync(libraryFile(), JSON.stringify({ version: 1, $schema: "x", ...settings, refs }));
const readRefs = (file = libraryFile()): Array<Record<string, unknown>> =>
	(JSON.parse(readFileSync(file, "utf8")) as { refs: Array<Record<string, unknown>> }).refs;
const projectLibraryFile = () => join(project, ".pi", "pi-context-refs.json");
const writeProjectLibrary = (refs: unknown[]) => {
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(projectLibraryFile(), JSON.stringify({ version: 1, refs }));
};
const snippet = (name: string, text: string, extra: Record<string, unknown> = {}) => ({ name, kind: "snippet", text, ...extra });
const file = (name: string, path: string, extra: Record<string, unknown> = {}) => ({ name, kind: "file", path, ...extra });

type Answers = {
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	editor?: (title: string, prefill?: string) => Promise<string | undefined>;
	confirm?: (title: string, message: string) => Promise<boolean>;
};

let debug = (): string => "";

/** Polls until `ready` holds, so key presses and the previews that follow them have settled. */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (let waited = 0; waited < 3000; waited += 10) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${what}\n${debug()}`);
}

/** A TUI session with a real editor in the slot. `answers` stand in for the dialogs `/ref` uses. */
async function start(options: { trusted?: boolean; answers?: Answers; mode?: "tui" | "rpc"; slotTaken?: boolean } = {}) {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	const session = createFakeSession({ cwd: project, mode: options.mode ?? "tui", ...(options.trusted === undefined ? {} : { trusted: options.trusted }) });
	const slot: { factory: EditorFactory | undefined } = { factory: undefined };
	const pasted: string[] = [];
	const state: { editor?: CustomEditor } = {};
	session.ctx.sessionManager = { getBranch: () => [] };
	Object.assign(session.ctx.ui, {
		getEditorComponent: () => slot.factory,
		setEditorComponent: (next: EditorFactory | undefined) => {
			slot.factory = next;
		},
		getEditorText: () => state.editor?.getText() ?? "",
		pasteToEditor: (text: string) => {
			pasted.push(text);
			state.editor?.insertTextAtCursor(text);
		},
		select: async (title: string, choices: string[]) => options.answers?.select?.(title, choices),
		editor: async (title: string, prefill?: string) => options.answers?.editor?.(title, prefill),
		confirm: async (title: string, message: string) => options.answers?.confirm?.(title, message) ?? false,
	});
	await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
	assert.ok(slot.factory, "the package put its editor in the slot");
	const editor = slot.factory(FAKE_TUI as unknown as Parameters<EditorFactory>[0], THEME, keybindings) as CustomEditor;
	state.editor = editor;
	if (options.slotTaken) slot.factory = (tui, theme, kb) => new CustomEditor(tui, theme, kb);
	let provider = new CombinedAutocompleteProvider([], project) as ReturnType<(typeof session.autocompleteProviders)[number]>;
	for (const wrap of session.autocompleteProviders) provider = wrap(provider);
	editor.setAutocompleteProvider(provider);
	const opened: Array<Promise<void>> = [];
	editor.onExtensionShortcut = (data) => {
		if (!matchesKey(data, "alt+r")) return false;
		opened.push(Promise.resolve(host.shortcuts.get("alt+r")?.handler(session.ctx)));
		return true;
	};

	const type = async (text: string) => {
		for (const char of text) editor.handleInput(char);
		await new Promise((resolve) => setTimeout(resolve, 40));
	};
	const shown = (): ShownComponent => {
		const latest = session.customs.at(-1);
		assert.ok(latest, "an overlay is open");
		return latest;
	};
	const screen = (): string => shown().component.render(100).map(stripTerminalSequences).join("\n");
	/** The preview part of the overlay. */
	const preview = (): string => screen().split("── preview").slice(1).join("── preview");
	/** Presses alt+r in the editor and waits for the overlay to show. */
	const open = async () => {
		const before = session.customs.length;
		editor.handleInput(KEYS.alt_r);
		await until(() => session.customs.length > before, "the overlay to open");
	};
	const press = async (...keys: string[]) => {
		for (const key of keys) shown().component.handleInput?.(key);
	};
	/** Types into the overlay's filter. */
	const filter = (text: string) => press(...text);
	const finished = () => Promise.all(opened);
	debug = () => `${session.customs.at(-1)?.component.render(100).join("\n")}\nnotices: ${JSON.stringify(session.notices)}`;
	for (const promise of opened) promise.catch(() => {});
	const recordUse = (toolName: string, path: string) =>
		host.fire(
			"tool_result",
			{ type: "tool_result", toolName, toolCallId: "call-1", input: { path }, content: [], isError: false, details: undefined },
			session.ctx,
		);
	return { host, session, editor, pasted, type, shown, screen, preview, open, press, filter, finished, recordUse };
}

describe("alt+r", () => {
	it("registers the shortcut", async () => {
		const { host } = await start();
		assert.ok(host.shortcuts.has("alt+r"));
	});

	it("shows the inline list's sections and marks, in the same order, with a filter and the key hints", async () => {
		writeLibrary([
			snippet("terse", "Be brief.", { description: "Keep answers short", tags: ["style"] }),
			file("agents", "AGENTS.md", { description: "Repository rules" }),
			file("mine", "notes.md", { description: "Only here", scope: { path: project } }),
		]);
		writeProjectLibrary([snippet("deploy", "Run ./deploy", { description: "Team deploy" })]);
		initRepo(project);
		const { open, screen, session, press } = await start();
		await open();
		const text = screen();
		const labels = ["◆ mine", "■ deploy", "● terse", "● agents", "○ diff", "⧉ tag:style"];
		const positions = labels.map((label) => text.indexOf(label));
		assert.ok(
			positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? 0))),
			text,
		);
		for (const heading of ["── Scoped", "── Project", "── Global", "── Built-in", "── Bundles"]) assert.match(text, new RegExp(heading));
		assert.match(text, /filter:/);
		assert.match(text, /enter inserts/);
		assert.match(text, /ctrl\+e edits · ctrl\+d removes/, "the first row is a saved Ref");
		const provider = session.autocompleteProviders[0]?.(new CombinedAutocompleteProvider([], project));
		const inline = await provider?.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
		for (const item of inline?.items ?? []) assert.ok(text.includes(item.label), `${item.label} is in the overlay`);
		await press(KEYS.escape);
	});

	it("hides the Built-in Refs outside a git work tree, as the inline list does", async () => {
		writeLibrary([snippet("terse", "Be brief.")]);
		const { open, screen, press } = await start();
		await open();
		assert.doesNotMatch(screen(), /○ diff/);
		await press(KEYS.escape);
	});

	it("narrows as the filter is typed and widens again on Backspace", async () => {
		writeLibrary([snippet("terse", "x"), snippet("rules", "y"), file("agents", "AGENTS.md")]);
		const { open, screen, filter, press } = await start();
		await open();
		await filter("ter");
		assert.match(screen(), /terse/);
		assert.doesNotMatch(screen(), /rules|agents/);
		await filter("zz");
		assert.match(screen(), /No Ref answers "terzz"/);
		await press(KEYS.backspace, KEYS.backspace);
		await press(KEYS.backspace, KEYS.backspace, KEYS.backspace);
		assert.match(screen(), /rules/);
		await press(KEYS.escape);
	});

	it("moves the selection with the arrow keys and previews the selected Ref's Expansion", async () => {
		writeLibrary([snippet("terse", "Be brief."), snippet("rules", "Follow the rules.")]);
		const { open, screen, preview, press } = await start();
		await open();
		await until(() => preview().includes("Be brief."), "the first preview");
		assert.match(screen(), /preview · terse/);
		await press(KEYS.down);
		await until(() => preview().includes("Follow the rules."), "the second preview");
		assert.doesNotMatch(preview(), /Be brief\./);
		await press(KEYS.up);
		await until(() => preview().includes("Be brief."), "the first preview again");
		await press(KEYS.escape);
	});

	it("previews a File Ref as the Context block the model would get, and a failure as its note", async () => {
		writeLibrary([file("api", "src/api.ts"), file("gone", "nope.md")]);
		const { open, screen, press } = await start();
		await open();
		await until(() => screen().includes("export const api = 1;"), "the file preview");
		assert.match(screen(), /<context-ref name="api" kind="file"/);
		await press(KEYS.down);
		await until(() => screen().includes("error="), "the failure preview");
		assert.match(screen(), /<context-ref name="gone"/);
		await press(KEYS.escape);
	});

	it("previews a Bundle as its members' Expansions", async () => {
		writeLibrary([snippet("a", "alpha", { tags: ["t"] }), snippet("b", "beta", { tags: ["t"] })]);
		const { open, screen, filter, press } = await start();
		await open();
		await filter("tag:t");
		await until(() => screen().includes("alpha beta"), "the Bundle preview");
		await press(KEYS.escape);
	});

	it("does nothing outside the TUI", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { host, session } = await start({ mode: "rpc" });
		await host.shortcuts.get("alt+r")?.handler(session.ctx);
		assert.equal(session.customs.length, 0);
	});

	it("does not open a second overlay while one is open, and closes the open one when the session shuts down", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { host, session, open, editor, finished } = await start();
		await open();
		editor.handleInput(KEYS.alt_r);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(session.customs.length, 1);
		await host.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);
		await finished();
		assert.equal(session.customs[0]?.closed, true);
		assert.deepEqual(session.customs[0]?.result, { action: "close" });
	});
});

describe("picking from the overlay", () => {
	it("puts the Placeholder at the cursor of an empty draft", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, press, editor, finished, shown } = await start();
		await open();
		const askedBefore = shown().renders.requested;
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "[ref:terse]");
		// The key press itself asks for one repaint; the insert needs another, which the editor does not ask for itself.
		assert.equal(shown().renders.requested, askedBefore + 2);
	});

	it("replaces the typed Trigger and what follows it, filtering by it", async () => {
		writeLibrary([snippet("terse", "x"), snippet("rules", "y")]);
		const { open, press, editor, type, screen, finished } = await start();
		await type("see #ru");
		await open();
		assert.match(screen(), /rules/);
		assert.doesNotMatch(screen(), /terse/, "the filter starts as the text typed after the Trigger");
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "see [ref:rules]");
	});

	it("replaces a bare typed Trigger in the middle of a line and leaves the text after the cursor", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, press, editor, type, finished } = await start();
		await type("fix # now");
		for (let step = 0; step < 4; step++) editor.handleInput(KEYS.left);
		await open();
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "fix [ref:terse] now");
	});

	it("keeps a typed #123, which is another provider's, and inserts at the cursor", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, press, editor, type, finished } = await start();
		await type("see #123 ");
		await open();
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "see #123 [ref:terse]");
	});

	it("closes the inline list's leftovers: no list is open after the pick", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, press, editor, type, finished } = await start();
		await type("#te");
		await open();
		await press(KEYS.enter);
		await finished();
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(editor.isShowingAutocomplete(), false);
		assert.equal(editor.getText(), "[ref:terse]");
	});

	it("inserts one Placeholder per Bundle member the draft does not have", async () => {
		writeLibrary([snippet("a", "1", { tags: ["t"] }), snippet("b", "2", { tags: ["t"] }), snippet("c", "3", { tags: ["t"] })]);
		const { open, press, filter, editor, type, finished } = await start();
		await type("[ref:b] and #");
		await open();
		await filter("tag:t");
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "[ref:b] and [ref:a] [ref:c]");
	});

	it("leaves the draft alone when the overlay is closed with Escape", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, press, editor, type, finished } = await start();
		await type("see #te");
		await open();
		await press(KEYS.escape);
		await finished();
		assert.equal(editor.getText(), "see #te");
	});

	it("pastes at the cursor when the package's editor no longer holds the slot", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, press, pasted, editor, type, finished } = await start({ slotTaken: true });
		await type("see #te");
		await open();
		await press(KEYS.enter);
		await finished();
		assert.deepEqual(pasted, ["[ref:terse]"]);
		assert.equal(editor.getText(), "see #te[ref:terse]", "a draft it cannot edit keeps the typed token");
	});

	it("sends what it inserted through the input handler as the expansion", async () => {
		writeLibrary([snippet("terse", "Be brief.")]);
		const { open, press, editor, finished, host, session } = await start();
		await open();
		await press(KEYS.enter);
		await finished();
		const result = await host.fire("input", { type: "input", text: `${editor.getText()} now`, source: "interactive" }, session.ctx);
		assert.equal(result?.text, "Be brief. now");
	});
});

describe("Recent rows in the overlay", () => {
	it("lists the files the session used, below the saved Refs", async () => {
		writeLibrary([snippet("terse", "x")]);
		const { open, screen, recordUse, press } = await start();
		await recordUse("read", "src/api.ts");
		await open();
		const text = screen();
		assert.match(text, /── Recent/);
		assert.match(text, /↺ src\/api\.ts\s+recent · read just now/);
		assert.ok(text.indexOf("● terse") < text.indexOf("↺ src/api.ts"));
		await press(KEYS.escape);
	});

	it("switches a Recent row between path form and file form, and inserts the form shown", async () => {
		const { open, press, screen, recordUse, editor, finished, filter } = await start();
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.tab);
		assert.match(screen(), /sends its contents/);
		await press(KEYS.tab);
		assert.doesNotMatch(screen(), /sends its contents/);
		await press(KEYS.tab);
		await filter("");
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "[ref:file:src/api.ts]");
	});

	it("inserts the path form by default", async () => {
		const { open, press, recordUse, editor, finished } = await start();
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.enter);
		await finished();
		assert.equal(editor.getText(), "[ref:src/api.ts]");
	});

	it("keeps the form of a row while the filter changes", async () => {
		const { open, press, screen, recordUse, filter } = await start();
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.tab);
		await filter("a");
		await press(KEYS.backspace);
		assert.match(screen(), /sends its contents/);
		await press(KEYS.escape);
	});

	it("previews the path text for the path form and the file's block for the file form", async () => {
		const { open, press, preview, recordUse } = await start();
		await recordUse("read", "src/api.ts");
		await open();
		await until(
			() =>
				preview()
					.split("\n")
					.some((line) => line.trim() === "src/api.ts"),
			"the path text",
		);
		assert.doesNotMatch(preview(), /export const api/);
		await press(KEYS.tab);
		await until(() => preview().includes("export const api = 1;"), "the file preview");
		assert.match(preview(), /<context-ref name="src\/api\.ts" kind="file"/);
		await press(KEYS.escape);
	});

	it("sends the file-form Placeholder it inserted as a File block", async () => {
		const { open, press, recordUse, editor, finished, host, session } = await start();
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.tab, KEYS.enter);
		await finished();
		const result = await host.fire("input", { type: "input", text: `look at ${editor.getText()}`, source: "interactive" }, session.ctx);
		assert.match(result?.text ?? "", /<context-ref name="src\/api\.ts" kind="file"/);
		assert.match(result?.text ?? "", /export const api = 1;/);
	});

	it("refuses the keys that do not fit a row, and says why", async () => {
		writeLibrary([snippet("terse", "x", { tags: ["t"] })]);
		const { open, press, screen } = await start();
		await open();
		await press(KEYS.tab);
		assert.match(screen(), /Only a Recent row has a file form/);
		await press(KEYS.ctrlS);
		assert.match(screen(), /Only a Recent row can be saved as a Ref/);
		await press(KEYS.down);
		await press(KEYS.ctrlE);
		assert.match(screen(), /Only a saved Ref can be edited/);
		await press(KEYS.ctrlD);
		assert.match(screen(), /Only a saved Ref can be removed/);
		await press(KEYS.escape);
	});
});

describe("saving a Recent row", () => {
	it("asks for a File or Path choice and a name that starts as the file name, then saves a File Ref and opens the overlay again without the row", async () => {
		const asked: Array<{ title: string; options?: string[] | undefined; prefill?: string | undefined }> = [];
		const { open, press, recordUse, session, screen, finished } = await start({
			answers: {
				select: async (title, options) => {
					asked.push({ title, options });
					return options[0];
				},
				editor: async (title, prefill) => {
					asked.push({ title, prefill });
					return prefill;
				},
			},
		});
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.ctrlS);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.deepEqual(
			asked.map((entry) => entry.options),
			[["File: send its contents", "Path: insert its path"], undefined],
		);
		assert.equal(asked[0]?.title, "Save src/api.ts as");
		assert.equal(asked[1]?.prefill, "api.ts");
		assert.deepEqual(readRefs(), [{ name: "api.ts", kind: "file", path: "src/api.ts" }]);
		assert.ok(
			session.notices.some((notice) => /Added file Ref "api\.ts"/.test(notice.message)),
			JSON.stringify(session.notices),
		);
		assert.doesNotMatch(screen(), /↺ src\/api\.ts/, "a saved Ref's target is no longer offered as a Recent row");
		assert.match(screen(), /● api\.ts\s+file/);
		await press(KEYS.escape);
		await finished();
	});

	it("saves a Path Ref under the name the person edited", async () => {
		const { open, press, recordUse, session } = await start({
			answers: { select: async (_title, options) => options[1], editor: async () => "  the-api  " },
		});
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.ctrlS);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.deepEqual(readRefs(), [{ name: "the-api", kind: "path", path: "src/api.ts" }]);
		await press(KEYS.escape);
	});

	it("suggests -2 for a clash in the Global library, and asks again with the problem until the name is valid and free", async () => {
		writeLibrary([snippet("api.ts", "taken")]);
		const titles: string[] = [];
		const answers = ["api.ts", "bad name", "api-file"];
		const prefills: Array<string | undefined> = [];
		const { open, press, recordUse, session } = await start({
			answers: {
				select: async (_title, options) => options[0],
				editor: async (title, prefill) => {
					titles.push(title);
					prefills.push(prefill);
					return answers.shift();
				},
			},
		});
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.down, KEYS.ctrlS);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.equal(prefills[0], "api.ts-2");
		assert.match(titles[1] ?? "", /"api\.ts" is already in the Global library/);
		assert.match(titles[2] ?? "", /uses only letters, digits/);
		assert.equal(prefills[2], "bad name");
		assert.deepEqual(
			readRefs().map((ref) => ref.name),
			["api.ts", "api-file"],
		);
		await press(KEYS.escape);
	});

	it("saves nothing when the choice or the name is cancelled", async () => {
		const { open, press, recordUse, session } = await start({ answers: { select: async () => undefined } });
		await recordUse("read", "src/api.ts");
		await open();
		await press(KEYS.ctrlS);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.equal(existsSync(libraryFile()), false);
		assert.ok(session.notices.some((notice) => /Cancelled; nothing was saved/.test(notice.message)));
		await press(KEYS.ctrlS);
		await until(() => session.customs.length === 3, "the overlay to open once more");
		await press(KEYS.escape);
		const second = await start({ answers: { select: async (_title, options) => options[0], editor: async () => undefined } });
		await second.recordUse("read", "src/api.ts");
		await second.open();
		await second.press(KEYS.ctrlS);
		await until(() => second.session.customs.length === 2, "the overlay to open again");
		assert.equal(existsSync(libraryFile()), false);
		await second.press(KEYS.escape);
	});
});

describe("editing and removing in the overlay", () => {
	it("edits a saved Ref in the JSON editor of /ref edit and opens the overlay again with the change", async () => {
		writeLibrary([snippet("terse", "Be brief.", { description: "Keep answers short" })]);
		const edits: Array<{ title: string; prefill?: string | undefined }> = [];
		const { open, press, session, screen } = await start({
			answers: {
				editor: async (title, prefill) => {
					edits.push({ title, prefill });
					return JSON.stringify({ name: "terse", kind: "snippet", text: "Be very brief.", description: "Shorter" });
				},
			},
		});
		await open();
		await press(KEYS.ctrlE);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.equal(edits[0]?.title, 'Edit "terse"');
		assert.equal(
			edits[0]?.prefill,
			JSON.stringify(readRefs()[0] && { name: "terse", kind: "snippet", text: "Be brief.", description: "Keep answers short" }, null, 2),
		);
		assert.deepEqual(readRefs(), [{ name: "terse", kind: "snippet", text: "Be very brief.", description: "Shorter" }]);
		assert.match(screen(), /Shorter/);
		assert.match(screen(), /ctrl\+e edits/, "the selection is where it was");
		await press(KEYS.escape);
	});

	it("reopens the editor with the problem while the edit is invalid, as /ref edit does", async () => {
		writeLibrary([snippet("terse", "Be brief.")]);
		const titles: string[] = [];
		const results = ["{ not json", JSON.stringify({ name: "terse", kind: "snippet", text: "Fixed." })];
		const { open, press, session } = await start({
			answers: {
				editor: async (title) => {
					titles.push(title);
					return results.shift();
				},
			},
		});
		await open();
		await press(KEYS.ctrlE);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.match(titles[1] ?? "", /not valid JSON/);
		assert.equal(readRefs()[0]?.text, "Fixed.");
		await press(KEYS.escape);
	});

	it("edits a Project library Ref in the Project library file", async () => {
		writeProjectLibrary([snippet("deploy", "Run ./deploy")]);
		const { open, press, session } = await start({
			answers: { editor: async () => JSON.stringify({ name: "deploy", kind: "snippet", text: "Run ./deploy --fast" }) },
		});
		await open();
		await press(KEYS.ctrlE);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.equal(readRefs(projectLibraryFile())[0]?.text, "Run ./deploy --fast");
		await press(KEYS.escape);
	});

	it("removes a saved Ref after the confirm of /ref remove, and opens the overlay again without it", async () => {
		writeLibrary([snippet("terse", "Be brief."), snippet("rules", "Follow.")]);
		const confirms: Array<{ title: string; message: string }> = [];
		const { open, press, session, screen } = await start({
			answers: {
				confirm: async (title, message) => {
					confirms.push({ title, message });
					return true;
				},
			},
		});
		await open();
		await press(KEYS.ctrlD);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.equal(confirms[0]?.title, 'Remove "terse"?');
		assert.match(confirms[0]?.message ?? "", /snippet Ref in the Global library/);
		assert.match(confirms[0]?.message ?? "", /The text is lost for good\./);
		assert.deepEqual(
			readRefs().map((ref) => ref.name),
			["rules"],
		);
		assert.doesNotMatch(screen(), /terse/);
		await press(KEYS.escape);
	});

	it("keeps the Ref when the confirm is declined", async () => {
		writeLibrary([snippet("terse", "Be brief.")]);
		const { open, press, session, screen } = await start({ answers: { confirm: async () => false } });
		await open();
		await press(KEYS.ctrlD);
		await until(() => session.customs.length === 2, "the overlay to open again");
		assert.equal(readRefs().length, 1);
		assert.match(screen(), /terse/);
		assert.ok(session.notices.some((notice) => notice.message === 'Kept "terse"'));
		await press(KEYS.escape);
	});

	it("does not edit or remove a Built-in Ref, and says how to change one", async () => {
		initRepo(project);
		const { open, press, screen, session, filter } = await start();
		await open();
		await filter("diff");
		await press(KEYS.ctrlE);
		assert.match(screen(), /A Built-in Ref cannot be edited; a saved Ref with the same name shadows it/);
		await press(KEYS.ctrlD);
		assert.match(screen(), /A Built-in Ref cannot be removed/);
		assert.equal(session.customs.length, 1, "the overlay stayed open");
		assert.equal(session.customs[0]?.closed, false);
		await press(KEYS.escape);
	});
});

describe("previews and Approvals", () => {
	const marker = () => join(project, "ran.txt");
	const command = ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker())}, "ran"); console.log("from the command")`];

	it("runs a Global Dynamic Ref for its preview without asking", async () => {
		writeLibrary([{ name: "cmd", kind: "dynamic", command }]);
		const { open, press, screen } = await start();
		await open();
		await until(() => screen().includes("from the command"), "the command's output");
		assert.equal(existsSync(marker()), true);
		await press(KEYS.escape);
	});

	it("does not run a Project Dynamic Ref that is not approved, and says how to approve it", async () => {
		writeProjectLibrary([{ name: "cmd", kind: "dynamic", command }]);
		const { open, press, screen } = await start();
		await open();
		await until(() => screen().includes("not approved yet"), "the refusal");
		assert.match(screen(), /\/ref approve cmd/);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(marker()), false);
		await press(KEYS.escape);
	});

	it("runs a Project Dynamic Ref for its preview once its exact definition is approved", async () => {
		writeProjectLibrary([{ name: "cmd", kind: "dynamic", command }]);
		const { host, session, open, press, screen } = await start({ answers: { confirm: async () => true } });
		await host.commands.get("ref")?.handler("approve cmd", session.ctx);
		assert.equal(existsSync(marker()), false, "approving does not run the command");
		await open();
		await until(() => screen().includes("from the command"), "the command's output");
		assert.equal(existsSync(marker()), true);
		await press(KEYS.escape);
	});

	it("does not run a command while the selection passes over its row", async () => {
		writeLibrary([
			{ name: "aaa", kind: "snippet", text: "first" },
			{ name: "cmd", kind: "dynamic", command },
			{ name: "zzz", kind: "snippet", text: "last" },
		]);
		const { open, press, screen } = await start();
		await open();
		await press(KEYS.down, KEYS.down);
		await until(() => screen().includes("last"), "the last preview");
		assert.equal(existsSync(marker()), false);
		await press(KEYS.escape);
	});
});
