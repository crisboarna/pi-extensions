// The package decorates the editor pi hands out (DESIGN.md section 6, ADR 0001). Real pi-tui editors
// are fed key bytes with no terminal, and the extension is loaded into the fake host the way pi loads it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Editor, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { decorateEditor, draftOf, type EditorFactory, registerEditor } from "../../src/pi/editor.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const KEYS = { backspace: "\x7f", left: "\x1b[D", right: "\x1b[C", ctrlW: "\x17", undo: "\x1f", home: "\x01" };
const BIG_PASTE = Array.from({ length: 12 }, (_, line) => `pasted line ${line}`).join("\n");
const PASTE_MARKER = "[paste #1 +12 lines]";

const identity = (text: string) => text;
const THEME = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
const FAKE_TUI = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

type Slot = { factory: EditorFactory | undefined };
type Build = (...args: Parameters<EditorFactory>) => ReturnType<EditorFactory>;

let agentDir = "";
let project = "";
// pi builds its own keybindings manager on top of this one; pi's package does not export it, and the editor only asks it to match keys.
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as Parameters<EditorFactory>[2];

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "context-refs-editor-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => rmSync(join(agentDir, ".."), { recursive: true, force: true }));

/** Builds the editor the way pi does: the factory takes the TUI, the theme and the keybindings. */
const build = (factory: EditorFactory | undefined): Editor => {
	assert.ok(factory, "an editor factory is in the slot");
	const editor = factory(FAKE_TUI as unknown as Parameters<EditorFactory>[0], THEME, keybindings);
	assert.ok(editor instanceof Editor);
	return editor;
};

/** Feeds key bytes one at a time and lets the editor's asynchronous work settle. */
async function press(editor: Editor, ...keys: string[]): Promise<void> {
	for (const key of keys) editor.handleInput(key);
	await new Promise((resolve) => setTimeout(resolve, 20));
}
const typeText = (editor: Editor, text: string) => press(editor, ...text);
const paste = (editor: Editor, text: string) => press(editor, `\x1b[200~${text}\x1b[201~`);

/** An editor with the package's decoration, as the default editor of a TUI session gets it. */
function decoratedEditor(): Editor {
	const editor = new CustomEditor(FAKE_TUI as unknown as ConstructorParameters<typeof CustomEditor>[0], THEME, keybindings);
	assert.equal(decorateEditor(editor), true);
	return editor;
}

describe("an editor with the Placeholder decoration", () => {
	it("deletes the whole Placeholder with one Backspace", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "see [ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "see ");
	});

	it("skips over the Placeholder in one cursor move in both directions", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "[ref:api]x");
		await press(editor, KEYS.left, KEYS.left);
		await typeText(editor, "Y");
		assert.equal(editor.getText(), "Y[ref:api]x");
		await press(editor, KEYS.right);
		await typeText(editor, "Z");
		assert.equal(editor.getText(), "Y[ref:api]Zx");
	});

	it("deletes only the Placeholder with Ctrl+W, leaving the word before it", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "word [ref:api]");
		await press(editor, KEYS.ctrlW);
		assert.equal(editor.getText(), "word ");
	});

	it("restores a deleted Placeholder whole on undo", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "see [ref:api]");
		await press(editor, KEYS.backspace);
		await press(editor, KEYS.undo);
		assert.equal(editor.getText(), "see [ref:api]");
	});

	it("treats a Placeholder in pasted text as one unit", async () => {
		const editor = decoratedEditor();
		await paste(editor, "compare [ref:api] and [ref:docs]");
		assert.equal(editor.getText(), "compare [ref:api] and [ref:docs]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "compare [ref:api] and ");
	});

	it("keeps pi's own [paste #N] marker atomic beside a Placeholder", async () => {
		const editor = decoratedEditor();
		await paste(editor, BIG_PASTE);
		assert.equal(editor.getText(), PASTE_MARKER);
		await typeText(editor, " [ref:api] ");
		await press(editor, KEYS.home, KEYS.right, KEYS.backspace);
		assert.equal(editor.getText(), " [ref:api] ", "one Backspace deletes the whole paste marker");
		await press(editor, KEYS.left, KEYS.right);
		await press(editor, KEYS.right, KEYS.backspace);
		assert.equal(editor.getText(), "  ", "and one Backspace deletes the whole Placeholder");
	});

	it("treats path-form and file-form Placeholders as one unit", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "[ref:./README.md] and [ref:file:src/a.ts]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "[ref:./README.md] and ");
		await press(editor, KEYS.ctrlW);
		assert.equal(editor.getText(), "[ref:./README.md] ", "Ctrl+W takes the word before the cursor, not the Placeholder");
		await press(editor, KEYS.backspace, KEYS.backspace);
		assert.equal(editor.getText(), "", "the Placeholder goes with one Backspace");
	});

	it("leaves a Placeholder that is not closed, and other brackets, as the editor treats them", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "see [ref:api and [text");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "see [ref:api and [tex");
	});

	it("decorates an editor only once, however often it is asked", async () => {
		const editor = decoratedEditor();
		assert.equal(decorateEditor(editor), true);
		await typeText(editor, "[ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "");
	});
});

/** Stands in for an editor that is not a pi-tui `Editor`. */
const asEditor = (value: object) => value as unknown as ReturnType<EditorFactory>;

describe("the feature check", () => {
	it("leaves an editor without a segment method alone and reports it", () => {
		const editor = { handleInput() {}, getText: () => "" };
		assert.equal(decorateEditor(asEditor(editor)), false);
		assert.deepEqual(Object.keys(editor), ["handleInput", "getText"], "nothing was added");
	});

	it("rejects a segment member that is not a method", () => {
		const editor = { segment: "not a function" };
		assert.equal(decorateEditor(asEditor(editor)), false);
		assert.equal(editor.segment, "not a function");
	});
});

describe("draftOf", () => {
	it("reads the lines and the cursor of the editor", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "first");
		await press(editor, "\n");
		await typeText(editor, "second #a");
		const draft = draftOf(editor);
		assert.deepEqual(draft?.lines(), ["first", "second #a"]);
		assert.deepEqual(draft?.cursor(), { line: 1, col: 9 });
	});

	it("replaces the typed token before the cursor, whatever follows it", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "see #sr and more");
		await press(editor, ...Array.from({ length: 9 }, () => KEYS.left));
		draftOf(editor)?.replaceBeforeCursor("#sr", "[ref:a]");
		assert.equal(editor.getText(), "see [ref:a] and more");
		assert.deepEqual(draftOf(editor)?.cursor(), { line: 0, col: 11 });
	});

	it("deletes a token of wide characters one character at a time", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "x #é👍");
		draftOf(editor)?.replaceBeforeCursor("#é👍", "[ref:a]");
		assert.equal(editor.getText(), "x [ref:a]");
	});

	it("only deletes the token when the pick adds nothing", async () => {
		const editor = decoratedEditor();
		await typeText(editor, "[ref:a] #");
		draftOf(editor)?.replaceBeforeCursor("#", "");
		assert.equal(editor.getText(), "[ref:a] ");
	});

	it("is undefined for an editor that cannot report its lines and cursor or insert text", () => {
		assert.equal(draftOf(asEditor({ handleInput() {}, getText: () => "" })), undefined);
		assert.equal(draftOf(asEditor({ handleInput() {}, getLines: () => [], getCursor: () => ({ line: 0, col: 0 }) })), undefined);
	});
});

/** Loads the extension through jiti, as pi does, and gives it a session whose UI has an editor slot. */
async function boot(options: { hasUI?: boolean; slot?: Slot } = {}) {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	const slot: Slot = options.slot ?? { factory: undefined };
	const session = createFakeSession({ cwd: project, hasUI: options.hasUI ?? true });
	const writes: Array<EditorFactory | undefined> = [];
	Object.assign(session.ctx.ui, {
		getEditorComponent: () => slot.factory,
		setEditorComponent: (next: EditorFactory | undefined) => {
			writes.push(next);
			slot.factory = next;
		},
	});
	return { host, session, slot, writes };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const start = (booted: Booted) => booted.host.fire("session_start", { type: "session_start", reason: "startup" }, booted.session.ctx);

/** Another extension's editor, built on top of whatever editor factory was in the slot. */
const wrapping =
	(previous: EditorFactory | undefined): EditorFactory =>
	(tui, theme, kb) =>
		previous ? previous(tui, theme, kb) : new CustomEditor(tui, theme, kb);

describe("the extension in a TUI session", () => {
	it("puts a decorated editor in the slot at session start", async () => {
		const booted = await boot();
		await start(booted);
		assert.equal(booted.writes.length, 1);
		const editor = build(booted.slot.factory);
		await typeText(editor, "see [ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "see ");
	});

	it("builds on the editor another extension already put in the slot instead of replacing it", async () => {
		const marked: string[] = [];
		const other: EditorFactory = (tui, theme, kb) => {
			const editor = new CustomEditor(tui, theme, kb);
			marked.push("built by the other extension");
			return editor;
		};
		const booted = await boot({ slot: { factory: other } });
		await start(booted);
		const editor = build(booted.slot.factory);
		assert.deepEqual(marked, ["built by the other extension"]);
		await typeText(editor, "[ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "");
	});

	it("keeps Placeholders atomic after an editor swap that wraps the package's editor", async () => {
		const booted = await boot();
		await start(booted);
		booted.slot.factory = wrapping(booted.slot.factory);
		const editor = build(booted.slot.factory);
		await typeText(editor, "see [ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "see ");
	});

	it("leaves Placeholders as plain text after an editor swap that does not wrap, and they still expand on send", async () => {
		const booted = await boot();
		writeFileSync(
			join(agentDir, "pi-context-refs.json"),
			JSON.stringify({ version: 1, $schema: "x", refs: [{ name: "api", kind: "snippet", text: "the API notes" }] }),
		);
		await start(booted);
		booted.slot.factory = (tui, theme, kb) => new CustomEditor(tui, theme, kb);
		const editor = build(booted.slot.factory);
		await typeText(editor, "see [ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "see [ref:api", "one Backspace deletes one character");
		await typeText(editor, "]");
		const sent = await booted.host.fire("input", { type: "input", text: editor.getText(), source: "interactive" }, booted.session.ctx);
		assert.equal(sent.text, "see the API notes");
	});

	it("falls back to plain text, without an error, when the editor has no segment method", async () => {
		const bare = { getText: () => "", setText() {}, handleInput() {}, render: () => [], invalidate() {} };
		const booted = await boot({ slot: { factory: () => asEditor(bare) } });
		await start(booted);
		assert.equal(booted.session.notices.length, 0);
		const editor = booted.slot.factory?.(FAKE_TUI as unknown as Parameters<EditorFactory>[0], THEME, keybindings);
		assert.equal(editor, bare, "the editor comes back as the other extension built it");
		assert.deepEqual(Object.keys(bare), ["getText", "setText", "handleInput", "render", "invalidate"]);
	});

	it("does not wrap its own editor again when the session starts twice in a row", async () => {
		const booted = await boot();
		await start(booted);
		await start(booted);
		assert.equal(booted.writes.length, 1);
	});

	it("wraps again when something else holds the slot at the next session start", async () => {
		const booted = await boot();
		await start(booted);
		booted.slot.factory = (tui, theme, kb) => new CustomEditor(tui, theme, kb);
		await start(booted);
		assert.equal(booted.writes.length, 2);
		const editor = build(booted.slot.factory);
		await typeText(editor, "[ref:api]");
		await press(editor, KEYS.backspace);
		assert.equal(editor.getText(), "");
	});

	it("takes no editor slot without a UI (print and JSON mode)", async () => {
		const booted = await boot({ hasUI: false });
		await start(booted);
		assert.equal(booted.writes.length, 0);
		assert.equal(booted.slot.factory, undefined);
	});
});

describe("the editor tap at session shutdown", () => {
	it("lets go of the editor it built, and finds the draft again once pi builds the next one", async () => {
		const host = createFakeHost();
		const tap = registerEditor(host.pi as unknown as Parameters<typeof registerEditor>[0]);
		const session = createFakeSession({ cwd: project, hasUI: true });
		const slot: Slot = { factory: undefined };
		Object.assign(session.ctx.ui, {
			getEditorComponent: () => slot.factory,
			setEditorComponent: (next: EditorFactory) => {
				slot.factory = next;
			},
		});
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		build(slot.factory);
		assert.ok(tap.draft(session.ctx), "the draft of the editor in the slot");

		await host.fire("session_shutdown", { type: "session_shutdown", reason: "new" }, session.ctx);
		assert.equal(tap.draft(session.ctx), undefined);

		await host.fire("session_start", { type: "session_start", reason: "new" }, session.ctx);
		build(slot.factory);
		assert.ok(tap.draft(session.ctx));
	});
});

/** Keeps `Build` in use for the type of the editor-building helper. */
export type { Build };
