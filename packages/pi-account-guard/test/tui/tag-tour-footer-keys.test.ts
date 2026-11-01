// Layer B: the tag checklist, the tour and the footer under the keys of pi's real TUI. Real interactive pi runs in this
// process on a virtual terminal. `integration/tag-prompt.test.ts` drives the checklist through a fake `ui.custom`;
// here pi mounts it, so the cursor, the validation message, the Esc fall-through and the footer are drawn by pi.
//
// covers: src/pi/tag-checklist.ts, src/pi/tag-prompt.ts, src/pi/tour.ts, src/pi/hooks.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STUB_MODEL, STUB_REPLY } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const SPACE = " ";
const NEEDS_ONE = "Check at least one zone, or press esc to cancel.";

async function withTui(
	body: (tui: TuiSession, requests: () => string[]) => Promise<void>,
	options: { config?: unknown; columns?: number } = {},
): Promise<void> {
	const log = join(mkdtempSync(join(tmpdir(), "account-guard-requests-")), "requests.txt");
	const requests = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
	const tui = await TuiSession.start({
		...(options.config !== undefined ? { config: options.config } : {}),
		...(options.columns !== undefined ? { columns: options.columns } : {}),
		env: { STUB_REQUEST_LOG: log },
	});
	try {
		await tui.ready();
		await body(tui, requests);
	} finally {
		await tui.close();
	}
}

/** Sends `hello` from an untagged account, which opens the tag checklist. */
async function openChecklist(tui: TuiSession): Promise<void> {
	tui.terminal.type("hello");
	await tui.waitForEditor((text) => text === "hello");
	tui.terminal.press(ENTER);
	await tui.terminal.waitForScreen((screen) => screen.includes("Which zones does stub"));
}

/** The last rows pi drew, blank rows of the terminal below them left out. */
const bottomRows = (screen: string) =>
	screen
		.split("\n")
		.filter((row) => row.trim())
		.slice(-14)
		.join("\n");
const screenHas = (tui: TuiSession, text: string) => tui.terminal.waitForScreen((screen) => screen.includes(text));
const savedAccount = (tui: TuiSession) => {
	const file = join(tui.agentDir, "account-guard.json");
	if (!existsSync(file)) return undefined;
	const config = JSON.parse(readFileSync(file, "utf8")) as { accounts: Array<{ provider: string; zones: string[] }> };
	return config.accounts.find((account) => account.provider === "stub");
};

describe("the tag checklist under the keys of pi's real TUI", () => {
	it("opens with nothing checked, the cursor on the first zone and the key hints, and sends nothing", () =>
		withTui(async (tui, requests) => {
			await openChecklist(tui);
			const screen = await tui.terminal.screen();
			assert.match(screen, /> \[ \] work\n\s+\[ \] personal/);
			assert.match(screen, /up\/down move, space checks, enter confirms, esc cancels/);
			assert.match(screen, /guard personal \? untagged/, "the footer says the account is untagged");
			assert.deepEqual(requests(), []);
		}));

	it("moves the cursor with Down and Up, stops at both ends, and Space checks and unchecks", () =>
		withTui(async (tui) => {
			await openChecklist(tui);
			tui.terminal.press(DOWN);
			await screenHas(tui, "> [ ] personal");
			tui.terminal.press(DOWN);
			tui.terminal.press(SPACE);
			await screenHas(tui, "> [x] personal");
			tui.terminal.press(SPACE);
			await screenHas(tui, "> [ ] personal");
			tui.terminal.press(UP);
			tui.terminal.press(UP);
			await screenHas(tui, "> [ ] work");
		}));

	it("Enter with nothing checked says so, keeps the checklist open, and writes nothing", () =>
		withTui(async (tui, requests) => {
			await openChecklist(tui);
			tui.terminal.press(ENTER);
			await screenHas(tui, NEEDS_ONE);
			assert.equal(savedAccount(tui), undefined);
			assert.deepEqual(requests(), []);
			tui.terminal.press(SPACE);
			await tui.terminal.waitForScreen((screen) => screen.includes("> [x] work") && !screen.includes(NEEDS_ONE.slice(0, 20)));
		}));

	it("tagging the place's zone writes the tag, sends the turn at once, and the footer shows the Match", () =>
		withTui(async (tui, requests) => {
			await openChecklist(tui);
			tui.terminal.press(DOWN);
			tui.terminal.press(SPACE);
			tui.terminal.press(ENTER);
			await screenHas(tui, STUB_REPLY);
			assert.deepEqual(savedAccount(tui)?.zones, ["personal"]);
			assert.deepEqual(requests(), [STUB_MODEL]);
			assert.match(await tui.terminal.screen(), /guard personal ✓/);
		}));

	it("tagging another zone writes that tag and ends in the Block of a work account in a personal place", () =>
		withTui(async (tui, requests) => {
			await openChecklist(tui);
			tui.terminal.press(SPACE);
			tui.terminal.press(ENTER);
			await screenHas(tui, "BLOCKED  stub (fallback) is zone work");
			assert.deepEqual(savedAccount(tui)?.zones, ["work"]);
			assert.deepEqual(requests(), []);
		}));

	it("Escape falls through to the Block of an untagged account, and Cancel puts the prompt back with nothing written", () =>
		withTui(async (tui, requests) => {
			await openChecklist(tui);
			tui.terminal.press(ESC);
			await screenHas(tui, "BLOCKED  stub (fallback) has no zone tag");
			for (let press = 0; press < 2; press++) tui.terminal.press(DOWN);
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => !screen.includes("BLOCKED"));
			await tui.waitForEditor((text) => text === "hello");
			assert.equal(savedAccount(tui), undefined);
			assert.deepEqual(requests(), []);
		}));
});

describe("the tour under the keys of pi's real TUI", () => {
	it("steps forward with Enter on Next, and Escape closes it", () =>
		withTui(async (tui) => {
			tui.terminal.type("/guard tour");
			await tui.waitForEditor((text) => text === "/guard tour");
			tui.terminal.press(ENTER);
			await screenHas(tui, "pi-account-guard tour 1/");
			const first = await tui.terminal.screen();
			assert.match(first, /→ Next →/);
			tui.terminal.press(ENTER);
			await screenHas(tui, "pi-account-guard tour 2/");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !/tour \d\/\d/.test(bottomRows(screen)));
			tui.terminal.type("x");
			await tui.waitForEditor((text) => text === "x");
		}));
});

describe("the footer under pi's real TUI", () => {
	it("shows a Match from the first frame when the account is tagged for the place's zone, and the turn needs no dialog", () =>
		withTui(
			async (tui, requests) => {
				assert.match(await tui.terminal.screen(), /guard personal ✓/);
				tui.terminal.type("hello");
				await tui.waitForEditor((text) => text === "hello");
				tui.terminal.press(ENTER);
				await screenHas(tui, STUB_REPLY);
				assert.deepEqual(requests(), [STUB_MODEL]);
			},
			{ config: { accounts: [{ provider: "stub", source: "fallback", zones: ["personal"] }] } },
		));

	it("keeps the footer line inside a narrow terminal", () =>
		withTui(
			async (tui) => {
				const rows = (await tui.terminal.screen()).split("\n");
				const footer = rows.find((row) => row.includes("guard personal"));
				assert.ok(footer, "the footer is drawn");
				assert.ok(footer.length <= 40, `the footer fits 40 columns, got ${footer.length}: ${footer}`);
			},
			{ config: { accounts: [{ provider: "stub", source: "fallback", zones: ["personal"] }] }, columns: 40 },
		));
});
