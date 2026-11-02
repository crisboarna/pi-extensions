// Layer B: the two dialogs of `src/index.ts` under the keys of pi's real TUI. `/tier models` without a flag asks which config to edit
// (the user's or the project's) before the tier editor opens; `/tier eval` asks before it sends sample requests to a classifier that
// runs off this machine, because each request may cost. Real interactive pi runs in this process on a virtual terminal. The remote
// classifier is a declared provider on a host that never resolves, so an answer of Yes fails fast and nothing leaves the machine.
//
// covers: src/index.ts, src/commands/eval.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_CONFIG } from "../support/harness.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const MENU = "pi-switchboard profiles";
const REMOTE = "remote/judge";
const CONFIG = {
	...BASE_CONFIG,
	classifierProviders: [...BASE_CONFIG.classifierProviders, { name: "remote", baseUrl: "https://classifier.example.invalid/v1/", models: ["judge"] }],
	classifiers: [{ model: REMOTE, timeoutMs: 1000, threshold: 0.8, warmup: false }, ...BASE_CONFIG.classifiers],
};

/** Whether `screen` shows `text`, whatever the terminal broke across rows: all whitespace is left out on both sides. */
const shows = (screen: string, text: string): boolean => screen.replace(/\s+/g, "").includes(text.replace(/\s+/g, ""));

async function withTui(body: (tui: TuiSession) => Promise<void>): Promise<void> {
	const tui = await TuiSession.start({ config: CONFIG });
	try {
		await tui.ready();
		await body(tui);
	} finally {
		await tui.close();
	}
}

describe("/tier models asks which config to edit, under the keys of pi's real TUI", () => {
	it("offers the user's config and the project's, with the user's selected first", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/tier models", "Edit which config?");
			const choice = await tui.terminal.waitForScreen((screen) => screen.includes("/project/.pi/") && screen.includes("→"));
			assert.match(choice, /enter select/);
			assert.ok(choice.indexOf("→") < choice.indexOf("/project/.pi/"), "the selected row comes before the project's");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes("Edit which config?"));
			assert.ok(!(await tui.terminal.screen()).includes(MENU), "Escape opens nothing");
		}));

	it("Enter on the first opens the editor on the user's config", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/tier models", "Edit which config?");
			await tui.terminal.waitForScreen((screen) => screen.includes("/project/.pi/"));
			tui.terminal.press(ENTER);
			const editor = await tui.terminal.waitForScreen((screen) => screen.includes(MENU));
			assert.ok(!shows(editor, "/.pi/pi-switchboard.json"), "it is not the project's file");
			assert.match(editor, /→ profile: work \(default\)/, "the user's config has the profile");
		}));

	it("Down then Enter opens the editor on the project's config, which has no profiles yet", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/tier models", "Edit which config?");
			await tui.terminal.waitForScreen((screen) => screen.includes("/project/.pi/"));
			tui.terminal.press(DOWN);
			await tui.terminal.waitForScreen((screen) => /→\s*\n\s*\/\S*\/project\/\.pi\/pi-swi/.test(screen));
			tui.terminal.press(ENTER);
			const editor = await tui.terminal.waitForScreen((screen) => screen.includes(MENU));
			assert.ok(shows(editor, "/project/.pi/pi-switchboard.json"), "the title names the project's file");
			assert.match(editor, /→ \+ new profile/);
			assert.ok(!editor.includes("profile: work"));
		}));

	it("asks nothing when the flag says which config", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/tier models --global", MENU);
			assert.ok(!(await tui.terminal.screen()).includes("Edit which config?"));
		}));
});

describe("/tier eval asks before using a classifier that runs off this machine, under the keys of pi's real TUI", () => {
	it("says what it sends and what it may cost, and offers Yes first", () =>
		withTui(async (tui) => {
			const confirm = await tui.terminal.runCommand(`/tier eval ${REMOTE}`, `Evaluate ${REMOTE}?`);
			await tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
			assert.ok(shows(confirm, `${REMOTE} runs off this machine.`));
			assert.ok(shows(confirm, "sample texts (none of your session)"));
			assert.ok(shows(confirm, "which your provider may charge for."));
			assert.match(await tui.terminal.screen(), /→ Yes\s*\n\s+No/);
			assert.ok(!shows(confirm, "Asking remote/judge about"), "nothing is asked while the question is open");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes(`Evaluate ${REMOTE}?`));
		}));

	it("No asks the classifier nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand(`/tier eval ${REMOTE}`, `Evaluate ${REMOTE}?`);
			await tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
			await tui.terminal.chooseRow("No");
			await tui.terminal.waitForScreen((screen) => !screen.includes(`Evaluate ${REMOTE}?`));
			await new Promise((resolve) => setTimeout(resolve, 400));
			const screen = await tui.terminal.screen();
			assert.ok(!shows(screen, "Asking remote/judge"), "no request was sent");
			assert.ok(!shows(screen, "classifier eval:"), "no report");
		}));

	it("Escape counts as No", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand(`/tier eval ${REMOTE}`, `Evaluate ${REMOTE}?`);
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes(`Evaluate ${REMOTE}?`));
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.ok(!shows(await tui.terminal.screen(), "classifier eval:"));
		}));

	it("Yes sends the sample requests, and says so when the classifier does not answer", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand(`/tier eval ${REMOTE}`, `Evaluate ${REMOTE}?`);
			await tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
			tui.terminal.press(ENTER);
			const report = await tui.terminal.waitForScreen((screen) => shows(screen, `classifier eval: ${REMOTE} at threshold 0.8`));
			assert.ok(shows(report, `${REMOTE} did not answer`));
		}));
});
