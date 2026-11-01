// Layer B: the Block of a prompt sent to an account of the wrong zone, under the keys of pi's real selector. Real pi's
// interactive mode runs in this process on a virtual terminal. `smoke/interactive-block.test.ts` serves the same
// dialogs over RPC; only here do pi's own selector, the editor refill and the repaint after Cancel get exercised.
//
// covers: src/pi/interactive-block.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SECOND_PROVIDER } from "../support/second-provider.ts";
import { STUB_MODEL, STUB_REPLY } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const CONFIG = {
	accounts: [
		{ provider: "stub", source: "fallback", zones: ["work"] },
		{ provider: SECOND_PROVIDER, source: "fallback", zones: ["personal"] },
	],
};

/** Starts a session in a personal place on the work account, types `hello` and sends it, which opens the Block. */
async function withBlockedPrompt(body: (tui: TuiSession, requests: () => string[]) => Promise<void>): Promise<void> {
	const log = join(mkdtempSync(join(tmpdir(), "account-guard-requests-")), "requests.txt");
	const requests = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
	const tui = await TuiSession.start({ config: CONFIG, env: { STUB_REQUEST_LOG: log } });
	try {
		await tui.ready();
		tui.terminal.type("hello");
		await tui.waitForEditor((text) => text === "hello");
		tui.terminal.press(ENTER);
		await tui.terminal.waitForScreen((screen) => screen.includes("BLOCKED"));
		await body(tui, requests);
	} finally {
		await tui.close();
	}
}

const selectorClosed = (tui: TuiSession) => tui.terminal.waitForScreen((screen) => !screen.includes("BLOCKED"));

describe("the Block selector under the keys of pi's real TUI", () => {
	it("lists the rows in order with pi's key hints, and sends nothing while it is open", () =>
		withBlockedPrompt(async (tui, requests) => {
			const screen = await tui.terminal.screen();
			const rows = ["→ Switch to stubtwo (fallback)", "Allow once: this turn to stub (fallback)", "Allow for session: stub (fallback)", "Cancel"];
			const positions = rows.map((row) => screen.indexOf(row));
			assert.ok(
				positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? 0))),
				`the four rows are on screen in order:\n${screen}`,
			);
			assert.match(screen, /↑↓ navigate {2}enter select {2}escape\/ctrl\+c cancel/);
			assert.deepEqual(requests(), []);
		}));

	it("Enter on the first row switches to the other account and sends the same prompt", () =>
		withBlockedPrompt(async (tui, requests) => {
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(STUB_REPLY));
			const screen = await tui.terminal.screen();
			assert.match(screen, new RegExp(`Switched to ${SECOND_PROVIDER} \\(fallback\\), sending\\.`));
			assert.match(screen, new RegExp(`\\(${SECOND_PROVIDER}\\) ${STUB_MODEL}`), "the footer shows the new account's model");
			assert.match(screen, /guard personal ✓/);
			assert.deepEqual(requests(), [STUB_MODEL]);
			assert.equal(await tui.editor(), "");
		}));

	it("Down, Down, Enter is Allow for session: the turn is sent and the footer shows the Override", () =>
		withBlockedPrompt(async (tui, requests) => {
			tui.terminal.press(DOWN);
			tui.terminal.press(DOWN);
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(STUB_REPLY));
			assert.match(await tui.terminal.screen(), /guard OVERRIDE stub in personal/);
			assert.deepEqual(requests(), [STUB_MODEL]);
		}));

	it("Down, Enter, Enter is Allow once confirmed: the turn is sent", () =>
		withBlockedPrompt(async (tui, requests) => {
			tui.terminal.press(DOWN);
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("Send ONE turn to stub (fallback)"));
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(STUB_REPLY));
			assert.deepEqual(requests(), [STUB_MODEL]);
		}));

	it("Allow once answered No puts the prompt back and sends nothing", () =>
		withBlockedPrompt(async (tui, requests) => {
			tui.terminal.press(DOWN);
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("Send ONE turn to stub (fallback)"));
			tui.terminal.press(DOWN);
			tui.terminal.press(ENTER);
			await selectorClosed(tui);
			await tui.waitForEditor((text) => text === "hello");
			assert.deepEqual(requests(), []);
		}));

	it("Escape is Cancel: the prompt is back in the editor, drawn, and nothing is sent", () =>
		withBlockedPrompt(async (tui, requests) => {
			tui.terminal.press(ESC);
			await selectorClosed(tui);
			await tui.waitForEditor((text) => text === "hello");
			assert.match(await tui.terminal.screen(), /guard personal ✗ stub is work/, "the footer still shows the block");
			assert.deepEqual(requests(), []);
		}));

	it("the Cancel row does the same as Escape", () =>
		withBlockedPrompt(async (tui, requests) => {
			for (let press = 0; press < 3; press++) tui.terminal.press(DOWN);
			tui.terminal.press(ENTER);
			await selectorClosed(tui);
			await tui.waitForEditor((text) => text === "hello");
			assert.deepEqual(requests(), []);
		}));
});
