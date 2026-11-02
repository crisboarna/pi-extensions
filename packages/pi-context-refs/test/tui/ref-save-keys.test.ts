// Layer B: saving a Recent row from the `alt+r` overlay under the keys of pi's real TUI. A file the session used (here one a sent message
// pointed at with `@notes.md`) is a Recent row; Ctrl+S on it asks whether to save it as a File or a Path Ref, then asks for the name in
// pi's multi-line editor, which starts with a suggestion and asks again until the name is valid and free. Real interactive pi runs in
// this process on a virtual terminal, and what is saved is read back from the Global library file.
//
// covers: src/pi/ref-save.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { nameProblem } from "../../src/core/names.ts";
import { QUIET_REPLY } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const ALT_R = "\x1br";
const CTRL_S = "\x13";
const END = "\x05";
const BACKSPACE = "\x7f";
const AS_FILE = "File: send its contents";
const AS_PATH = "Path: insert its path";
/** A Recent row's selection mark in the overlay, as opposed to the one on a saved or Built-in row. */
const ON_RECENT = /› ↺/;
const TAKEN = { name: "notes.md", kind: "snippet", text: "already here" };

/** The screen with all whitespace left out, for a title whose path the terminal breaks across rows wherever the path happens to fall. */
const squashed = (screen: string): string => screen.replace(/\s+/g, "");

/** Whether `screen` shows `text`, whatever the terminal broke across rows: all whitespace is left out on both sides. */
const shows = (screen: string, text: string): boolean => screen.replace(/\s+/g, "").includes(text.replace(/\s+/g, ""));

/** What the name editor holds: the one row between two rules, the last such pair on the screen. */
function nameInEditor(screen: string): string | undefined {
	const rows = screen.split("\n");
	const rules = rows.flatMap((row, index) => (/^─{20,}\s*$/.test(row) ? [index] : []));
	for (let pair = rules.length - 1; pair > 0; pair--) {
		const [top, bottom] = [rules[pair - 1], rules[pair]];
		if (top !== undefined && bottom !== undefined && bottom - top === 2) return rows[top + 1]?.trim();
	}
	return undefined;
}

interface Session {
	tui: TuiSession;
	/** The Refs in the Global library file. */
	saved(): Array<Record<string, unknown>>;
}

async function withTui(refs: unknown[], body: (session: Session) => Promise<void>): Promise<void> {
	const tui = await TuiSession.start({ ...(refs.length > 0 ? { library: { version: 1, refs } } : {}), env: { STUB_QUIET: "1" } });
	try {
		await tui.ready();
		writeFileSync(join(tui.project, "notes.md"), "# notes\n");
		const file = join(tui.agentDir, "pi-context-refs.json");
		await body({ tui, saved: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { refs: Array<Record<string, unknown>> }).refs : []) });
	} finally {
		await tui.close();
	}
}

/** Sends a message that points at notes.md, so that the file is a Recent row, then opens the overlay. */
async function openOverlay(tui: TuiSession): Promise<void> {
	tui.terminal.type("read @notes.md");
	await tui.waitForEditor((text) => text === "read @notes.md");
	tui.terminal.press(ENTER);
	await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
	tui.terminal.press(ALT_R);
	await tui.terminal.waitForScreen((screen) => screen.includes("Context refs") && screen.includes("↺"));
}

/** Moves the selection down to the Recent row, one key at a time. */
async function selectRecent(tui: TuiSession): Promise<void> {
	for (let key = 0; key < 12 && !ON_RECENT.test(await tui.terminal.screen()); key++) {
		tui.terminal.press(DOWN);
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
	await tui.terminal.waitForScreen((screen) => ON_RECENT.test(screen));
}

/** Opens the overlay on the Recent row and presses Ctrl+S, which asks how to save it. */
async function startSave(tui: TuiSession): Promise<string> {
	await openOverlay(tui);
	await selectRecent(tui);
	tui.terminal.press(CTRL_S);
	return tui.terminal.waitForScreen((screen) => /Save\/\S*\/project\/notes\.mdas/.test(squashed(screen)) && screen.includes(AS_FILE));
}

/** Opens the name question for a File Ref and resolves with the screen. */
async function askName(tui: TuiSession): Promise<string> {
	await startSave(tui);
	await tui.terminal.chooseRow(AS_FILE);
	return tui.terminal.waitForScreen((screen) => screen.includes("Name of the file Ref for") && nameInEditor(screen) !== undefined);
}

/** Empties the name editor, which starts with a suggestion. */
function clearName(tui: TuiSession, name: string): void {
	tui.terminal.press(END);
	for (let key = 0; key < name.length; key++) tui.terminal.press(BACKSPACE);
}

describe("saving a Recent row under the keys of pi's real TUI", () => {
	it("refuses on a Built-in row and says only a Recent row can be saved", () =>
		withTui([], async ({ tui, saved }) => {
			await openOverlay(tui);
			tui.terminal.press(CTRL_S);
			await tui.terminal.waitForScreen((screen) => screen.includes("Only a Recent row can be saved as a Ref"));
			assert.ok(!(await tui.terminal.screen()).includes("Save "), "no question was asked");
			assert.deepEqual(saved(), []);
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes("Context refs"));
		}));

	it("asks File or Path with the path shown, then the name starting from a suggestion, and Enter saves a File Ref", () =>
		withTui([], async ({ tui, saved }) => {
			const choice = await startSave(tui);
			assert.match(squashed(choice), /Save\/\S*\/project\/notes\.mdas/);
			assert.match(choice, new RegExp(`→ ${AS_FILE}\\s*\\n\\s+${AS_PATH}`), "the two forms, File first and selected");
			assert.match(choice, /enter select/);
			await tui.terminal.chooseRow(AS_FILE);
			const editor = await tui.terminal.waitForScreen((screen) => screen.includes("Name of the file Ref for") && nameInEditor(screen) !== undefined);
			assert.match(squashed(editor), /NameofthefileReffor\/\S*\/project\/notes\.md/);
			assert.equal(nameInEditor(editor), "notes.md", "the name starts as the file name");
			assert.match(editor, /enter submit {2}shift\+enter\/ctrl\+j newline {2}escape\/ctrl\+c cancel/);
			assert.deepEqual(saved(), [], "nothing is saved while the name is asked");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("● notes.md"));
			const [ref, ...rest] = saved();
			assert.equal(rest.length, 0);
			assert.equal(ref?.name, "notes.md");
			assert.equal(ref?.kind, "file");
			assert.match(JSON.stringify(ref), /project\/notes\.md/);
		}));

	it("saves a Path Ref when Path is chosen, and says so in the name question", () =>
		withTui([], async ({ tui, saved }) => {
			await startSave(tui);
			await tui.terminal.chooseRow(AS_PATH);
			await tui.terminal.waitForScreen((screen) => screen.includes("Name of the path Ref for"));
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("● notes.md"));
			assert.equal(saved()[0]?.kind, "path");
		}));

	it("Escape at the choice saves nothing and says so", () =>
		withTui([], async ({ tui, saved }) => {
			await startSave(tui);
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => screen.includes("Cancelled; nothing was saved"));
			assert.deepEqual(saved(), []);
		}));

	it("Escape at the name saves nothing and says so", () =>
		withTui([], async ({ tui, saved }) => {
			await askName(tui);
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => screen.includes("Cancelled; nothing was saved"));
			assert.deepEqual(saved(), []);
		}));

	it("asks for the name again with the reason in the title when it is not a valid name", () =>
		withTui([], async ({ tui, saved }) => {
			const problem = nameProblem("bad name");
			assert.ok(problem, "a name with a space is not valid");
			await askName(tui);
			clearName(tui, "notes.md");
			tui.terminal.type("bad name");
			await tui.terminal.waitForScreen((screen) => nameInEditor(screen) === "bad name");
			tui.terminal.press(ENTER);
			const again = await tui.terminal.waitForScreen((screen) => shows(screen, `notes.md: ${problem}`));
			assert.match(again, /enter submit/, "the editor is open again");
			assert.deepEqual(saved(), [], "nothing is saved under a name that is not valid");
			clearName(tui, "bad name");
			tui.terminal.type("good");
			await tui.terminal.waitForScreen((screen) => nameInEditor(screen) === "good");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("● good"));
			assert.equal(saved()[0]?.name, "good");
		}));

	it("starts from a free name when the file name is taken, and asks again if the person types a taken one", () =>
		withTui([TAKEN], async ({ tui, saved }) => {
			const editor = await askName(tui);
			const suggested = nameInEditor(editor);
			assert.ok(suggested && suggested !== "notes.md", `the suggestion is not the name that is taken (it is ${JSON.stringify(suggested)})`);
			clearName(tui, suggested);
			tui.terminal.type("notes.md");
			await tui.terminal.waitForScreen((screen) => nameInEditor(screen) === "notes.md");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => shows(screen, 'notes.md: "notes.md" is already in'));
			assert.equal(saved().length, 1, "only the Ref that was there before");
		}));
});
