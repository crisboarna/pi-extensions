// Layer B: the read-only dialog of `/ref sent` under the keys of pi's real TUI. Real interactive pi runs in this process on a
// virtual terminal; the sent message is long enough that the dialog has to scroll. Pi's default TUI mode is fullscreen, where pi
// keeps PageUp and PageDown for its own scrolling unless the dialog is an overlay, so the page keys run in both modes.
//
// covers: src/pi/text-viewer.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUIET_REPLY } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const TITLE = "Last message sent, as the model received it";
const LINES = 80;
const SNIPPET = Array.from({ length: LINES }, (_, index) => `line ${String(index + 1).padStart(2, "0")} of the snippet`).join("\n");
const LIBRARY = { version: 1, refs: [{ name: "long", kind: "snippet", text: SNIPPET }] };

/** The first row of the dialog's text, which is what scrolling moves. */
async function firstRow(tui: TuiSession): Promise<string | undefined> {
	const rows = (await tui.terminal.screen()).split("\n");
	const title = rows.findIndex((row) => row.includes(TITLE));
	return title < 0 ? undefined : rows[title + 2]?.trim();
}

/** The dialog's hint line: the keys it names and the rows it shows. */
async function hint(tui: TuiSession): Promise<string | undefined> {
	return (await tui.terminal.screen())
		.split("\n")
		.find((row) => row.includes("Esc closes"))
		?.trim();
}

async function waitUntil(check: () => Promise<boolean>, what: string, tui: TuiSession, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}; the screen shows:\n${await tui.terminal.screen()}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const waitForFirstRow = (tui: TuiSession, text: string) => waitUntil(async () => (await firstRow(tui)) === text, `the first row is "${text}"`, tui);
const viewerClosed = (tui: TuiSession) => tui.terminal.waitForScreen((screen) => !screen.includes(TITLE));

/** Types `/ref sent`. The first Enter may only close pi's command completion, so Enter is pressed until the dialog is up. */
async function open(tui: TuiSession): Promise<void> {
	tui.terminal.type("/ref sent");
	await tui.waitForEditor((text) => text === "/ref sent");
	for (let attempt = 0; attempt < 3; attempt++) {
		tui.terminal.press(ENTER);
		const opened = await tui.terminal
			.waitForScreen((screen) => screen.includes(TITLE), 500)
			.then(
				() => true,
				() => false,
			);
		if (opened) return;
	}
	throw new Error(`the viewer did not open:\n${await tui.terminal.screen()}`);
}

/** Sends a message holding the long snippet, then opens `/ref sent`. */
async function withViewer(body: (tui: TuiSession) => Promise<void>, settings?: Record<string, unknown>): Promise<void> {
	const tui = await TuiSession.start({ library: LIBRARY, env: { STUB_QUIET: "1" }, ...(settings ? { settings } : {}) });
	try {
		await tui.ready();
		tui.terminal.type("go [ref:long]");
		await tui.waitForEditor((text) => text === "go [ref:long]");
		tui.terminal.press(ENTER);
		await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
		await open(tui);
		await body(tui);
	} finally {
		await tui.close();
	}
}

describe("the /ref sent dialog under the keys of pi's real TUI", () => {
	it("opens on the message as the model received it, expanded, from its first line", () =>
		withViewer(async (tui) => {
			assert.equal(await firstRow(tui), "go line 01 of the snippet");
			assert.ok(!(await tui.terminal.screen()).includes("[ref:long]"), "the Placeholder is shown expanded");
		}));

	it("scrolls one row with Down and Up, to the end with End, and back to the top with Home", () =>
		withViewer(async (tui) => {
			tui.terminal.press(DOWN);
			await waitForFirstRow(tui, "line 02 of the snippet");
			tui.terminal.press(DOWN);
			await waitForFirstRow(tui, "line 03 of the snippet");
			tui.terminal.press(UP);
			await waitForFirstRow(tui, "line 02 of the snippet");
			tui.terminal.press(END);
			await tui.terminal.waitForScreen((screen) => screen.includes(`line ${LINES} of the snippet`));
			tui.terminal.press(HOME);
			await waitForFirstRow(tui, "go line 01 of the snippet");
			tui.terminal.press(UP);
			assert.equal(await firstRow(tui), "go line 01 of the snippet", "Up at the top stays at the top");
		}));

	for (const [name, key] of [
		["Escape", ESC],
		["Enter", ENTER],
		["q", "q"],
	] as const) {
		it(`${name} closes it, and the editor takes keys again`, () =>
			withViewer(async (tui) => {
				tui.terminal.press(key);
				await viewerClosed(tui);
				tui.terminal.type("x");
				await tui.waitForEditor((text) => text === "x");
			}));
	}

	// The page keys, in each of pi's two TUI modes. In fullscreen, the default, pi takes PageUp and PageDown for its own scrolling
	// unless the dialog is an overlay; a version of the dialog that was not one scrolled nothing here and lost its hint line.
	for (const [mode, settings] of [
		["fullscreen", undefined],
		["regular", { tuiMode: "regular" }],
	] as const) {
		it(`scrolls a page with PageDown and back with PageUp, and draws its hint with the range (${mode} mode)`, () =>
			withViewer(async (tui) => {
				assert.match((await hint(tui)) ?? "", /PgUp\/PgDn.*\(1-36 of 8\d\)/);
				tui.terminal.press(PAGE_DOWN);
				await waitForFirstRow(tui, "line 37 of the snippet");
				assert.match((await hint(tui)) ?? "", /\(37-72 of 8\d\)/);
				tui.terminal.press(PAGE_UP);
				await waitForFirstRow(tui, "go line 01 of the snippet");
			}, settings));
	}
});
