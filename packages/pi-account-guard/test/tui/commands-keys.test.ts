// Layer B: the dialogs of `/guard tag` and `/guard zone add` under the keys of pi's real TUI. Real interactive pi runs in this process
// on a virtual terminal. The unit and integration tests drive these commands with a fake `ui`; here pi draws the selector, the
// confirm and the input, so the rows, the default answer, Escape and the config the command writes are checked as a person meets them.
//
// covers: src/pi/commands.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TuiSession } from "../support/tui-session.ts";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const SPACE = " ";
const ENTER = "\r";
const TAGGED_WORK = {
	zones: ["work", "personal"],
	defaultZone: "personal",
	accounts: [{ provider: "stub", source: "fallback", zones: ["work"] }],
	places: [],
};

interface SavedConfig {
	zones: string[];
	accounts: Array<{ provider: string; zones: string[] }>;
}
const saved = (tui: TuiSession): SavedConfig => JSON.parse(readFileSync(join(tui.agentDir, "account-guard.json"), "utf8")) as SavedConfig;
const stubZones = (tui: TuiSession) => saved(tui).accounts.find((account) => account.provider === "stub")?.zones;

async function withTui(body: (tui: TuiSession) => Promise<void>): Promise<void> {
	const tui = await TuiSession.start({ config: TAGGED_WORK });
	try {
		await tui.ready();
		await body(tui);
	} finally {
		await tui.close();
	}
}

/** Runs `/guard tag` and ticks `personal`, which changes the zones of an account tagged `work`, so a confirm follows. */
async function tagAsPersonal(tui: TuiSession): Promise<void> {
	await tui.terminal.runCommand("/guard tag", "Which zones does stub");
	tui.terminal.press(DOWN);
	tui.terminal.press(SPACE);
	await tui.terminal.waitForScreen((screen) => screen.includes("> [x] personal"));
	tui.terminal.press(ENTER);
	// the title is drawn before the rows, so wait for the first row too
	await tui.terminal.waitForScreen((screen) => screen.includes("Change the zones of stub (fallback)?") && screen.includes("→ Yes"));
}

describe("/guard tag under the keys of pi's real TUI", () => {
	it("asks for the zones, then confirms the change from the old zones to the new, and Yes writes it and updates the footer", () =>
		withTui(async (tui) => {
			await tagAsPersonal(tui);
			const confirm = await tui.terminal.screen();
			assert.match(confirm, /work -> personal/, "the confirm shows what changes");
			assert.match(confirm, /→ Yes\s*\n\s+No/, "Yes is the default row");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("Tagged stub (fallback) as personal."));
			assert.deepEqual(stubZones(tui), ["personal"]);
			assert.match(await tui.terminal.screen(), /guard personal ✓/, "the footer follows the new tag");
		}));

	it("No leaves the config and the footer as they were", () =>
		withTui(async (tui) => {
			await tagAsPersonal(tui);
			await tui.terminal.chooseRow("No");
			await tui.terminal.waitForScreen((screen) => !screen.includes("Change the zones of"));
			assert.deepEqual(stubZones(tui), ["work"]);
			const screen = await tui.terminal.screen();
			assert.match(screen, /guard personal ✗ stub is work/);
			assert.ok(!screen.includes("Tagged stub"), "no success notice");
		}));

	it("Escape in the zone checklist cancels, and nothing is written or confirmed", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard tag", "Which zones does stub");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes("Which zones does stub"));
			assert.deepEqual(stubZones(tui), ["work"]);
			assert.ok(!(await tui.terminal.screen()).includes("Change the zones of"));
		}));

	it("naming the same zones again says so and asks nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard tag", "Which zones does stub");
			tui.terminal.press(SPACE);
			await tui.terminal.waitForScreen((screen) => screen.includes("> [x] work"));
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("is already tagged as work."));
			assert.ok(!(await tui.terminal.screen()).includes("Change the zones of"));
			assert.deepEqual(stubZones(tui), ["work"]);
		}));
});

describe("/guard zone add under the keys of pi's real TUI", () => {
	it("asks for a name in an input dialog and adds the zone to the config", () =>
		withTui(async (tui) => {
			const screen = await tui.terminal.runCommand("/guard zone add", "Name of the new zone?");
			assert.match(screen, /enter submit {2}escape\/ctrl\+c cancel/, "the input dialog shows its key hints");
			tui.terminal.answer("lab");
			await tui.terminal.waitForScreen((current) => !current.includes("Name of the new zone?"));
			assert.deepEqual(saved(tui).zones, ["work", "personal", "lab"]);
		}));

	it("Escape cancels the input and adds nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone add", "Name of the new zone?");
			tui.terminal.type("lab");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes("Name of the new zone?"));
			assert.deepEqual(saved(tui).zones, ["work", "personal"]);
		}));

	it("an empty answer adds nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone add", "Name of the new zone?");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => !screen.includes("Name of the new zone?"));
			assert.deepEqual(saved(tui).zones, ["work", "personal"]);
			assert.ok(existsSync(join(tui.agentDir, "account-guard.json")));
		}));
});
