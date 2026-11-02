// Layer B: the tier editor (`/tier models`) under the keys of pi's real TUI. Real interactive pi runs in this process on a virtual
// terminal. The editor is a stack of pi selects, inputs and confirms: profiles, tiers and members, then a save that shows a diff and
// asks first. The unit tests drive it with a scripted `ui`; here the rows, the key hints, Escape and Back, and the file that results
// (and the `.bak` copy of the one it replaced) are checked as a person meets them.
//
// covers: src/tui/editor.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, it } from "node:test";
import type { RawConfig } from "../../src/config/types.ts";
import { STRATEGY_NAMES } from "../../src/config/types.ts";
import { stableStringify } from "../../src/tui/editor.ts";
import { BASE_CONFIG } from "../support/harness.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const MENU = "pi-switchboard profiles";
const BACK = "← back";
const SAVE = "✓ save and close";
const CLOSE = "✗ close without saving";
const TIER = "Tier standard (rank 2, ordered, 2 members)";
const RELOADED = "Run /reload so the virtual models re-register.";
/** The models pi lists in the session, which the editor offers. */
const MODELS = ["acme/big", "acme/mid", "acme/small", "zen/mid"];

interface Saved {
	profiles: Record<string, { tiers: Record<string, { rank: number; strategy?: unknown; members: unknown[] }>; fallbackTier?: string }>;
	profileSelection?: { default?: string };
}

/** Whether `screen` shows `text`, whatever the terminal broke across rows: all whitespace is left out on both sides. */
const shows = (screen: string, text: string): boolean => screen.replace(/\s+/g, "").includes(text.replace(/\s+/g, ""));

interface Editor {
	tui: TuiSession;
	/** The config file as saved. */
	saved(): Saved;
	/** The `.bak` copies beside it. */
	backups(): string[];
	/** Chooses a row and waits for the dialog with `title` to take its place. */
	go(row: string, title: string): Promise<string>;
	/** Types an answer into an input dialog and presses Enter. */
	answer(text: string): Promise<void>;
}

/** A session whose config file is written the way the editor writes it, so that a change shows as a short diff. */
async function withEditor(body: (editor: Editor) => Promise<void>, options: { rows?: number } = {}): Promise<void> {
	const tui = await TuiSession.start({ config: BASE_CONFIG, ...(options.rows ? { rows: options.rows } : {}) });
	try {
		await tui.ready();
		writeFileSync(tui.configPath, stableStringify(JSON.parse(JSON.stringify(BASE_CONFIG)) as RawConfig));
		await tui.terminal.runCommand("/tier models --global", MENU);
		await body({
			tui,
			saved: () => JSON.parse(readFileSync(tui.configPath, "utf8")) as Saved,
			backups: () => readdirSync(dirname(tui.configPath)).filter((name) => name.startsWith(`${basename(tui.configPath)}.`) && name.endsWith(".bak")),
			async go(row, title) {
				await tui.terminal.chooseRow(row);
				return tui.terminal.waitForScreen((screen) => screen.includes(title));
			},
			async answer(text) {
				tui.terminal.type(text);
				await tui.terminal.waitForScreen((screen) =>
					screen.split("\n").some((row) => row.replace(/\s+$/, "").endsWith(`> ${text}`) || row.trim() === `>${text}`),
				);
				tui.terminal.press(ENTER);
			},
		});
	} finally {
		await tui.close();
	}
}

/** The members of the standard tier, as the editor wrote them. */
const standard = (editor: Editor): unknown[] => editor.saved().profiles.work?.tiers.standard?.members ?? [];

/** Opens the standard tier's member list. */
async function openMembers(editor: Editor): Promise<string> {
	await editor.go("profile: work (default)", "Profile work");
	await editor.go("tier: standard", TIER);
	return editor.go("members", "Members");
}

/** Backs out to the profile list from the member list, a tier or a profile. */
async function backToMenu(editor: Editor, from: "members" | "tier" | "profile"): Promise<void> {
	if (from === "members") await editor.go(BACK, "Tier standard");
	if (from === "members" || from === "tier") await editor.go(BACK, "Profile work");
	await editor.go(BACK, MENU);
}

/** Saves from the profile list and answers the confirm; resolves with the confirm's screen. */
async function save(editor: Editor, answer: "Yes" | "No"): Promise<string> {
	const confirm = await editor.go(SAVE, "Save");
	await editor.tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
	if (answer === "No") await editor.tui.terminal.chooseRow("No");
	else editor.tui.terminal.press(ENTER);
	return confirm;
}

describe("the tier editor's menus under the keys of pi's real TUI", () => {
	it("lists the profiles with the default marked, and the three ways to leave", () =>
		withEditor(async ({ tui }) => {
			const menu = await tui.terminal.screen();
			assert.match(menu, new RegExp(`→ profile: work \\(default\\)\\s*\\n\\s+\\+ new profile\\s*\\n\\s+${SAVE}\\s*\\n\\s+${CLOSE}`));
			assert.match(menu, /enter select {2}escape\/ctrl\+c cancel/);
			assert.ok(shows(menu, "pi-switchboard.json"), "the title names the file");
		}));

	it("lists a profile's tiers weakest first, then what can be done to the profile", () =>
		withEditor(async (editor) => {
			const profile = await editor.go("profile: work (default)", "Profile work");
			assert.match(
				profile,
				/→ tier: light\s*\n\s+tier: standard\s*\n\s+tier: deep\s*\n\s+\+ add tier\s*\n\s+fallback tier\s*\n\s+baseline tier\s*\n\s+direct tier\s*\n\s+make default\s*\n\s+rename\s*\n\s+delete profile\s*\n\s+← back/,
			);
		}));

	it("shows a tier's rank, strategy and member count in its title, and what can be done to it", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			const tier = await editor.go("tier: standard", TIER);
			assert.match(tier, /→ members\s*\n\s+rank\s*\n\s+strategy\s*\n\s+rename\s*\n\s+delete tier\s*\n\s+← back/);
		}));

	it("Escape at the profile list closes the editor and writes nothing", () =>
		withEditor(async ({ tui, saved, backups }) => {
			const before = JSON.stringify(saved());
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => !screen.includes(MENU));
			assert.equal(JSON.stringify(saved()), before);
			assert.deepEqual(backups(), []);
		}));
});

describe("the tier editor's members under the keys of pi's real TUI", () => {
	it("adds a member from the models pi lists with a thinking level, and shows it in the list", () =>
		withEditor(async (editor) => {
			const members = await openMembers(editor);
			assert.match(members, /→ \+ add member\s*\n\s+1\. acme\/mid\s*\n\s+2\. zen\/mid\s*\n\s+← back/);
			const models = await editor.go("+ add member", "Model");
			assert.match(
				models,
				new RegExp(
					`→ ${MODELS[0]}\\s*\\n${MODELS.slice(1)
						.map((model) => `\\s+${model}\\s*\\n`)
						.join("")}`,
				),
			);
			await editor.tui.terminal.chooseRow("acme/big");
			const levels = await editor.tui.terminal.waitForScreen((screen) => screen.includes("Thinking level"));
			assert.match(levels, /→ \(model default\)\s*\n\s+off\s*\n\s+minimal\s*\n\s+low\s*\n\s+medium\s*\n\s+high\s*\n\s+xhigh/);
			await editor.tui.terminal.chooseRow("high");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("3. acme/big:high"));
		}));

	it("marks a member disabled and shows its weight, from the member's own menu", () =>
		withEditor(async (editor) => {
			await openMembers(editor);
			const menu = await editor.go("1. acme/mid", "thinking level");
			assert.match(menu, /→ thinking level\s*\n\s+weight\s*\n\s+disable\s*\n\s+move up\s*\n\s+move down\s*\n\s+remove\s*\n\s+← back/);
			await editor.tui.terminal.chooseRow("disable");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("1. acme/mid (disabled)"));
			const again = await editor.go("1. acme/mid (disabled)", "thinking level");
			assert.match(again, /→ thinking level\s*\n\s+weight\s*\n\s+enable\s*\n/, "a disabled member can be enabled");
			await editor.go("weight", "Weight");
			await editor.answer("3");
			const list = await editor.tui.terminal.waitForScreen((screen) => screen.includes("1. acme/mid (disabled) ×3"));
			assert.match(list, /2\. zen\/mid/);
			assert.deepEqual(standard(editor), ["acme/mid", "zen/mid"], "nothing is written before a save");
		}));

	it("moves a member down and removes one", () =>
		withEditor(async (editor) => {
			await openMembers(editor);
			await editor.go("1. acme/mid", "thinking level");
			await editor.tui.terminal.chooseRow("move down");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("1. zen/mid") && screen.includes("2. acme/mid"));
			await editor.go("1. zen/mid", "thinking level");
			await editor.tui.terminal.chooseRow("remove");
			const list = await editor.tui.terminal.waitForScreen((screen) => screen.includes("1. acme/mid") && !screen.includes("zen/mid"));
			assert.doesNotMatch(list, /2\. /);
		}));
});

describe("the tier editor's tiers and profiles under the keys of pi's real TUI", () => {
	it("changes a tier's rank and strategy and shows them in its title", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			await editor.go("tier: standard", TIER);
			await editor.go("rank", "Rank (higher is stronger)");
			await editor.answer("5");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Tier standard (rank 5, ordered, 2 members)"));
			const strategies = await editor.go("strategy", "Strategy");
			assert.match(strategies, new RegExp(STRATEGY_NAMES.map((name, index) => `${index === 0 ? "→ " : "\\s+"}${name}\\s*\\n`).join("")));
			await editor.tui.terminal.chooseRow(STRATEGY_NAMES[1] as string);
			await editor.tui.terminal.waitForScreen((screen) => screen.includes(`Tier standard (rank 5, ${STRATEGY_NAMES[1]}, 2 members)`));
		}));

	it("renames a tier, and keeps the profile's references to it", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			await editor.go("tier: standard", TIER);
			await editor.go("rename", "New tier name");
			await editor.answer("regular");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Tier regular (rank 2, ordered, 2 members)"));
			await backToMenu(editor, "tier");
			await save(editor, "Yes");
			await editor.tui.terminal.waitForScreen((screen) => shows(screen, RELOADED));
			const profile = editor.saved().profiles.work;
			assert.deepEqual(Object.keys(profile?.tiers ?? {}).sort(), ["deep", "light", "regular"]);
			assert.equal(profile?.fallbackTier, "regular");
		}));

	it("asks before deleting a tier: No keeps it and Yes removes it", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			await editor.go("tier: standard", TIER);
			const ask = await editor.go("delete tier", "Delete tier");
			assert.match(ask, /Delete standard\?/);
			await editor.tui.terminal.chooseRow("No");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes(TIER));
			await editor.go("delete tier", "Delete tier");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
			editor.tui.terminal.press(ENTER);
			const profile = await editor.tui.terminal.waitForScreen((screen) => screen.includes("Profile work") && !screen.includes("tier: standard"));
			assert.match(profile, /tier: light\s*\n\s+tier: deep/);
		}));

	it("adds a tier from a name and a first model, one rank above the strongest", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			await editor.go("+ add tier", "Tier name (lowercase)");
			await editor.answer("max");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("First member"));
			await editor.tui.terminal.chooseRow("zen/mid");
			const profile = await editor.tui.terminal.waitForScreen((screen) => screen.includes("tier: max"));
			assert.match(profile, /tier: deep\s*\n\s+tier: max\s*\n\s+\+ add tier/, "the new tier comes last: it is the strongest");
		}));

	it("sets a fallback tier from the profile's tiers and the relative names", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			const choice = await editor.go("fallback tier", "fallback tier");
			assert.match(choice, /→ \(default\)\s*\n\s+light\s*\n\s+standard\s*\n\s+deep\s*\n\s+@top\s*\n\s+@middle\s*\n\s+@bottom/);
			await editor.tui.terminal.chooseRow("@top");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Profile work") && !screen.includes("@top"));
			await backToMenu(editor, "profile");
			await save(editor, "Yes");
			await editor.tui.terminal.waitForScreen((screen) => shows(screen, RELOADED));
			assert.equal(editor.saved().profiles.work?.fallbackTier, "@top");
		}));

	it("creates a profile from a name and a first model, then opens it", () =>
		withEditor(async (editor) => {
			await editor.go("+ new profile", "Profile name (lowercase)");
			await editor.answer("lab");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Model for the first tier"));
			await editor.tui.terminal.chooseRow("acme/small");
			const profile = await editor.tui.terminal.waitForScreen((screen) => screen.includes("Profile lab"));
			assert.match(profile, /→ tier: standard/);
			await editor.tui.terminal.chooseRow("make default");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Profile lab"));
			await backToMenu(editor, "profile");
			assert.match(await editor.tui.terminal.screen(), /profile: lab \(default\)/);
			await save(editor, "Yes");
			await editor.tui.terminal.waitForScreen((screen) => shows(screen, RELOADED));
			assert.equal(editor.saved().profileSelection?.default, "lab");
			assert.deepEqual(editor.saved().profiles.lab?.tiers.standard?.members, ["acme/small"]);
		}));

	it("asks before deleting a profile, and Yes removes it", () =>
		withEditor(async (editor) => {
			await editor.go("profile: work (default)", "Profile work");
			const ask = await editor.go("delete profile", "Delete profile");
			assert.match(ask, /Delete work\?/);
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
			editor.tui.terminal.press(ENTER);
			const menu = await editor.tui.terminal.waitForScreen((screen) => screen.includes(MENU) && !screen.includes("profile: work"));
			assert.match(menu, /→ \+ new profile/);
		}));
});

describe("the tier editor's save under the keys of pi's real TUI", () => {
	it("shows the change as a diff and asks, and Yes writes the file and keeps the one it replaced as a .bak", () =>
		withEditor(async (editor) => {
			await openMembers(editor);
			await editor.go("+ add member", "Model");
			await editor.tui.terminal.chooseRow("acme/big");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Thinking level"));
			await editor.tui.terminal.chooseRow("high");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("3. acme/big:high"));
			await backToMenu(editor, "members");
			const before = readFileSync(editor.tui.configPath, "utf8");
			const confirm = await save(editor, "Yes");
			assert.ok(shows(confirm, "pi-switchboard.json?"), "the question names the file");
			assert.match(confirm, /\+\s+"acme\/big:high"/, "the diff shows the added member");
			assert.match(confirm, /→ Yes\s*\n\s+No/);
			await editor.tui.terminal.waitForScreen((screen) => shows(screen, RELOADED));
			assert.deepEqual(standard(editor), ["acme/mid", "zen/mid", "acme/big:high"]);
			const [backup, ...rest] = editor.backups();
			assert.ok(backup && rest.length === 0, "one .bak copy");
			assert.equal(readFileSync(`${dirname(editor.tui.configPath)}/${backup}`, "utf8"), before, "the .bak is the file as it was");
		}));

	it("No writes nothing and keeps no .bak", () =>
		withEditor(async (editor) => {
			await openMembers(editor);
			await editor.go("1. acme/mid", "thinking level");
			await editor.tui.terminal.chooseRow("remove");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Members") && !screen.includes("acme/mid"));
			await backToMenu(editor, "members");
			const before = readFileSync(editor.tui.configPath, "utf8");
			await save(editor, "No");
			await editor.tui.terminal.waitForScreen((screen) => !screen.includes("→ Yes") && !screen.includes(MENU));
			assert.equal(readFileSync(editor.tui.configPath, "utf8"), before);
			assert.deepEqual(editor.backups(), []);
		}));

	it("closing without saving leaves the file as it was", () =>
		withEditor(async (editor) => {
			await openMembers(editor);
			await editor.go("1. acme/mid", "thinking level");
			await editor.tui.terminal.chooseRow("remove");
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("Members") && !screen.includes("acme/mid"));
			await backToMenu(editor, "members");
			const before = readFileSync(editor.tui.configPath, "utf8");
			await editor.tui.terminal.chooseRow(CLOSE);
			await editor.tui.terminal.waitForScreen((screen) => !screen.includes(MENU));
			assert.equal(readFileSync(editor.tui.configPath, "utf8"), before);
			assert.deepEqual(editor.backups(), []);
		}));

	it("says there is nothing to save when nothing changed", () =>
		withEditor(async (editor) => {
			await editor.tui.terminal.chooseRow(SAVE);
			await editor.tui.terminal.waitForScreen((screen) => screen.includes("No changes to save."));
			assert.deepEqual(editor.backups(), []);
		}));
});
