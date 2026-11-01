// Layer B: the dialogs of `/ref add`, `/ref remove` and `/ref edit` under the keys of pi's real TUI. Real interactive pi runs in this
// process on a virtual terminal. A command given no arguments asks in pi's input, selector, confirm and multi-line editor dialogs and
// then writes the library file; the unit and integration tests use a fake `ui`, so the rows, the key hints, Escape, the editor's
// error-in-the-title loop and the file that results are checked here as a person meets them.
//
// covers: src/pi/commands.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TuiSession } from "../support/tui-session.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const END = "\x05";
const BACKSPACE = "\x7f";
const ENTER = "\r";
const TERSE = { name: "terse", kind: "snippet", text: "Answer in one sentence." };
const LIBRARY = { version: 1, refs: [TERSE] };

const library = (tui: TuiSession): { refs: Array<Record<string, unknown>> } =>
	JSON.parse(readFileSync(join(tui.agentDir, "pi-context-refs.json"), "utf8")) as { refs: Array<Record<string, unknown>> };
const closed = (tui: TuiSession, title: string) => tui.terminal.waitForScreen((screen) => !screen.includes(title));

async function withTui(body: (tui: TuiSession) => Promise<void>): Promise<void> {
	const tui = await TuiSession.start({ library: LIBRARY });
	try {
		await tui.ready();
		await body(tui);
	} finally {
		await tui.close();
	}
}

describe("/ref add under the keys of pi's real TUI", () => {
	it("asks for the name, the kind, the text and where to save, in that order, and writes the Ref to the Global library", () =>
		withTui(async (tui) => {
			const nameDialog = await tui.terminal.runCommand("/ref add", "Name of the new Ref");
			assert.match(nameDialog, /enter submit {2}escape\/ctrl\+c cancel/);
			tui.terminal.answer("mine");
			const kinds = await tui.terminal.waitForScreen((screen) => screen.includes("dynamic") && screen.includes("Kind"));
			assert.match(kinds, /→ path\s*\n\s+file\s*\n\s+snippet\s*\n\s+dynamic/, "the four kinds, in order, the first selected");
			await tui.terminal.chooseRow("snippet");
			await tui.terminal.waitForScreen((screen) => screen.includes("Snippet text"));
			tui.terminal.answer("hello there");
			const places = await tui.terminal.waitForScreen((screen) => screen.includes("Save in") && screen.includes("Project library"));
			assert.match(
				places,
				/→ Global library\s*\n\s+Global library, scoped to this repository\s*\n\s+Project library/,
				"three places, the Global library first",
			);
			await tui.terminal.chooseRow("Global library");
			await tui.terminal.waitForScreen((screen) => screen.includes('Added snippet Ref "mine" to the Global library'));
			assert.deepEqual(library(tui).refs, [TERSE, { name: "mine", kind: "snippet", text: "hello there" }]);
		}));

	it("Escape at the name adds nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/ref add", "Name of the new Ref");
			tui.terminal.type("mine");
			tui.terminal.press(ESC);
			await closed(tui, "Name of the new Ref");
			assert.deepEqual(library(tui).refs, [TERSE]);
		}));

	it("Escape at the kind adds nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/ref add", "Name of the new Ref");
			tui.terminal.answer("mine");
			await tui.terminal.waitForScreen((screen) => screen.includes("Kind") && screen.includes("→ path"));
			tui.terminal.press(ESC);
			await closed(tui, "Kind");
			assert.deepEqual(library(tui).refs, [TERSE]);
		}));
});

describe("/ref remove under the keys of pi's real TUI", () => {
	it("asks which Ref, then shows it and warns that the text is lost, and Yes removes it", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/ref remove", "Remove which Ref?");
			await tui.terminal.chooseRow("terse");
			const confirm = await tui.terminal.waitForScreen((screen) => screen.includes('Remove "terse"?') && screen.includes("→ Yes"));
			assert.match(confirm, /snippet Ref in the Global library/);
			assert.match(confirm, /terse\s+snippet\s+"Answer in one sentence\."/, "the Ref is shown as the picker shows it");
			assert.match(confirm, /The text is lost for good\./);
			tui.terminal.press(ENTER);
			await closed(tui, 'Remove "terse"?');
			assert.deepEqual(library(tui).refs, []);
		}));

	it("No keeps the Ref", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/ref remove", "Remove which Ref?");
			await tui.terminal.chooseRow("terse");
			await tui.terminal.waitForScreen((screen) => screen.includes('Remove "terse"?') && screen.includes("→ Yes"));
			await tui.terminal.chooseRow("No");
			await closed(tui, 'Remove "terse"?');
			assert.deepEqual(library(tui).refs, [TERSE]);
		}));

	it("Escape at the choice keeps the Ref and asks nothing more", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/ref remove", "Remove which Ref?");
			tui.terminal.press(ESC);
			await closed(tui, "Remove which Ref?");
			assert.ok(!(await tui.terminal.screen()).includes('Remove "terse"?'));
			assert.deepEqual(library(tui).refs, [TERSE]);
		}));
});

describe("/ref edit under the keys of pi's real TUI", () => {
	async function openEditor(tui: TuiSession): Promise<string> {
		await tui.terminal.runCommand("/ref edit", "Edit which Ref?");
		await tui.terminal.chooseRow("terse");
		return tui.terminal.waitForScreen((screen) => screen.includes('Edit "terse"') && screen.includes("enter submit"));
	}

	it("opens the Ref as JSON in a multi-line editor, and a change to the text is saved", () =>
		withTui(async (tui) => {
			const editor = await openEditor(tui);
			assert.match(editor, /"name": "terse",\s*\n\s*"kind": "snippet",\s*\n\s*"text": "Answer in one sentence\."/);
			assert.match(editor, /enter submit {2}shift\+enter\/ctrl\+j newline {2}escape\/ctrl\+c cancel/);
			tui.terminal.press(UP);
			tui.terminal.press(END);
			tui.terminal.press(LEFT);
			tui.terminal.type("!");
			await tui.terminal.waitForScreen((screen) => screen.includes('"Answer in one sentence.!"'));
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes('Edited snippet Ref "terse"'));
			assert.deepEqual(library(tui).refs, [{ ...TERSE, text: "Answer in one sentence.!" }]);
		}));

	it("submitting without a change says so and writes nothing", () =>
		withTui(async (tui) => {
			await openEditor(tui);
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes('Nothing changed in "terse"'));
			assert.deepEqual(library(tui).refs, [TERSE]);
		}));

	it("broken JSON opens the editor again with the error in its title and the draft kept, and the library is untouched", () =>
		withTui(async (tui) => {
			await openEditor(tui);
			tui.terminal.press(BACKSPACE);
			tui.terminal.press(ENTER);
			const again = await tui.terminal.waitForScreen((screen) => screen.includes('Edit "terse": the text is not valid JSON'));
			assert.match(again, /"text": "Answer in one sentence\."/, "the draft is still there to fix");
			assert.deepEqual(library(tui).refs, [TERSE]);
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => screen.includes("Cancelled; nothing was changed"));
			assert.deepEqual(library(tui).refs, [TERSE]);
		}));
});
