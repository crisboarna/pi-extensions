// Layer B: `/tier watch`, the navigator overlay, under the keys of pi's real TUI. Real interactive pi runs in this
// process on a virtual terminal. `integration/extension.test.ts` feeds the component two keys through a stub of
// `ui.custom`; here pi mounts the overlay itself, so focus, the repaint, closing and a terminal resize are exercised too.
//
// covers: src/tui/pi-tui.ts, src/index.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BASE_CONFIG } from "../support/harness.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const OVERLAY = "switchboard ·";
/** Ctrl+Alt+W as a terminal in the Kitty keyboard protocol sends it: codepoint 119, modifiers 1 + alt 2 + ctrl 4. */
const CTRL_ALT_W = "\x1b[119;7u";

/** The overlay's rows as drawn, frame stripped. */
async function overlay(tui: TuiSession): Promise<string[]> {
	return (await tui.terminal.screen())
		.split("\n")
		.filter((row) => row.includes("│"))
		.map((row) => row.replace(/^[\s│]+|[\s│]+$/gu, ""))
		.filter(Boolean);
}

const selectedRow = async (tui: TuiSession) => (await overlay(tui)).find((row) => row.startsWith("›"));
const overlayClosed = (tui: TuiSession) => tui.terminal.waitForScreen((screen) => !screen.includes("╭") && !screen.includes(OVERLAY));

/** Types `/tier watch`. The first Enter may only close pi's command completion, so Enter is pressed until the overlay is up. */
async function openNavigator(tui: TuiSession): Promise<void> {
	tui.terminal.type("/tier watch");
	await tui.terminal.waitForScreen((screen) => screen.includes("/tier watch"));
	for (let attempt = 0; attempt < 3; attempt++) {
		tui.terminal.press(ENTER);
		const opened = await tui.terminal
			.waitForScreen((screen) => screen.includes(OVERLAY), 500)
			.then(
				() => true,
				() => false,
			);
		if (opened) return;
	}
	throw new Error(`the navigator did not open:\n${await tui.terminal.screen()}`);
}

async function withNavigator(body: (tui: TuiSession) => Promise<void>, options: { child?: boolean; columns?: number } = {}): Promise<void> {
	const tui = await TuiSession.start({ config: BASE_CONFIG, ...(options.columns !== undefined ? { columns: options.columns } : {}) });
	try {
		await tui.ready();
		if (options.child) {
			const live = join(tui.dataDir, "live");
			mkdirSync(live, { recursive: true });
			const now = Date.now();
			const status = {
				v: 1,
				session: "child-1",
				parent: tui.sessionId,
				agent: "scout",
				status: "running",
				turn: 1,
				tokens: { input: 10, output: 2, cacheRead: 0 },
				cost: 0,
				startedAt: now,
				updatedAt: now,
			};
			writeFileSync(join(live, "child-1.json"), JSON.stringify(status));
		}
		await openNavigator(tui);
		await body(tui);
	} finally {
		// The overlay's refresh timer is cleared only when it closes; pi's `stop` does not dispose it, and a tick after the
		// runtime is gone throws "ctx is stale" from a timer. `q` closes it from any view, and is plain text if it is closed.
		tui.terminal.press("q");
		await tui.terminal.waitForScreen((screen) => !screen.includes(OVERLAY), 1000).catch(() => {});
		await tui.close();
	}
}

describe("the navigator's shortcut under the keys of pi's real TUI", () => {
	it("Ctrl+Alt+W opens the navigator without typing a command, and Escape closes it", async () => {
		const tui = await TuiSession.start({ config: BASE_CONFIG });
		try {
			await tui.ready();
			tui.terminal.press(CTRL_ALT_W);
			await tui.terminal.waitForScreen((screen) => screen.includes(OVERLAY));
			assert.equal(await tui.editor(), "", "nothing was typed into the editor");
			tui.terminal.press(ESC);
			await overlayClosed(tui);
		} finally {
			await tui.close();
		}
	});
});

describe("the navigator overlay under the keys of pi's real TUI", () => {
	it("opens with the main row selected and the key hints, and Escape closes it", () =>
		withNavigator(async (tui) => {
			const rows = await overlay(tui);
			assert.match(rows[0] ?? "", /^⇄ switchboard · 0 running/);
			assert.match(await selectedRow(tui).then((row) => row ?? ""), /^› ○ main/);
			assert.ok(rows.includes("↑↓ move · enter decision · t transcript · esc close"));

			tui.terminal.press(ESC);
			await overlayClosed(tui);
			tui.terminal.type("x");
			await tui.waitForEditor((text) => text === "x");
		}));

	it("moves the selection with Down and Up, and stops at the last row", () =>
		withNavigator(
			async (tui) => {
				assert.match((await overlay(tui))[0] ?? "", /1 running/);
				tui.terminal.press(DOWN);
				await tui.terminal.waitForScreen((screen) => /› └ ● scout/u.test(screen));
				tui.terminal.press(DOWN);
				assert.match(await selectedRow(tui).then((row) => row ?? ""), /scout/, "Down on the last row stays on it");
				tui.terminal.press(UP);
				await tui.terminal.waitForScreen((screen) => /› ○ main/u.test(screen));
			},
			{ child: true },
		));

	it("Enter opens the decision of the selected row, `t` its transcript, and Escape steps back before it closes", () =>
		withNavigator(
			async (tui) => {
				tui.terminal.press(DOWN);
				tui.terminal.press(ENTER);
				await tui.terminal.waitForScreen((screen) => screen.includes("scout · decision"));

				tui.terminal.press("t");
				await tui.terminal.waitForScreen((screen) => screen.includes("scout · transcript"));

				tui.terminal.press(ESC);
				await tui.terminal.waitForScreen((screen) => /› └ ● scout/u.test(screen) && screen.includes(OVERLAY));

				tui.terminal.press(ESC);
				await overlayClosed(tui);
			},
			{ child: true },
		));

	it("q closes it from any row", () =>
		withNavigator(
			async (tui) => {
				tui.terminal.press(DOWN);
				tui.terminal.press("q");
				await overlayClosed(tui);
			},
			{ child: true },
		));

	it("ignores keys it does not use and keeps the typed text out of the editor while it is open", () =>
		withNavigator(async (tui) => {
			tui.terminal.type("zzz");
			tui.terminal.press("\x1b[C");
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.match((await overlay(tui))[0] ?? "", /^⇄ switchboard/);
			tui.terminal.press(ESC);
			await overlayClosed(tui);
			assert.equal(await tui.editor(), "", "the command cleared the editor, and the keys typed into the overlay did not land in it");
		}));

	it("redraws wider when the terminal is resized: the token and cost columns appear", () =>
		withNavigator(
			async (tui) => {
				assert.doesNotMatch((await overlay(tui)).join("\n"), /10\/2/, "at 100 columns the row is cut before its tokens");
				tui.terminal.resize(160);
				await tui.terminal.waitForScreen((screen) => /scout.*10\/2.*\$0/u.test(screen));
			},
			{ child: true },
		));
});
