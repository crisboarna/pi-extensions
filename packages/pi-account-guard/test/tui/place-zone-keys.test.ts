// Layer B: the dialogs of `/guard place` and `/guard zone` under the keys of pi's real TUI. Real interactive pi runs in this process on a
// virtual terminal; a command given no arguments asks for what it needs in pi's selector and input dialogs, and writes the config.
// Selections go by the row's text (`chooseRow`), not by counting arrow keys.
//
// covers: src/pi/place-zone-commands.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TuiSession } from "../support/tui-session.ts";

const ESC = "\x1b";
const CONFIG = {
	zones: ["work", "personal", "lab", "spare"],
	defaultZone: "personal",
	accounts: [{ provider: "stub", source: "fallback", zones: ["work"] }],
	places: [
		{ path: "/a", zone: "work" },
		{ path: "/b", zone: "lab" },
	],
};

interface SavedConfig {
	zones: string[];
	defaultZone: string;
	places: Array<{ path: string; zone: string }>;
}
const saved = (tui: TuiSession): SavedConfig => JSON.parse(readFileSync(join(tui.agentDir, "account-guard.json"), "utf8")) as SavedConfig;
const closed = (tui: TuiSession, title: string) => tui.terminal.waitForScreen((screen) => !screen.includes(title));

async function withTui(body: (tui: TuiSession) => Promise<void>): Promise<void> {
	const tui = await TuiSession.start({ config: CONFIG });
	try {
		await tui.ready();
		await body(tui);
	} finally {
		await tui.close();
	}
}

describe("/guard place remove under the keys of pi's real TUI", () => {
	it("lists the rules in order, and the chosen row is the rule removed", () =>
		withTui(async (tui) => {
			const screen = await tui.terminal.runCommand("/guard place remove", "Which rule?");
			assert.match(screen, /→ 1\. \/a -> work\s*\n\s+2\. \/b -> lab/, "the rules are listed with their numbers, the first selected");
			await tui.terminal.chooseRow("2. /b -> lab");
			await tui.terminal.waitForScreen((current) => current.includes("Removed rule 2 (/b -> lab)."));
			assert.deepEqual(saved(tui).places, [{ path: "/a", zone: "work" }]);
		}));

	it("Escape removes nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard place remove", "Which rule?");
			tui.terminal.press(ESC);
			await closed(tui, "Which rule?");
			assert.deepEqual(saved(tui).places, CONFIG.places);
		}));
});

describe("/guard place move under the keys of pi's real TUI", () => {
	it("asks which rule, then for the new position in an input dialog, and reorders the rules", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard place move", "Which rule?");
			await tui.terminal.chooseRow("1. /a -> work");
			const input = await tui.terminal.waitForScreen((screen) => screen.includes("Move rule 1 to which position (1 to 2)?"));
			assert.match(input, /enter submit {2}escape\/ctrl\+c cancel/);
			tui.terminal.answer("2");
			await closed(tui, "to which position");
			assert.deepEqual(saved(tui).places, [CONFIG.places[1], CONFIG.places[0]]);
		}));

	it("Escape in the position input leaves the order alone", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard place move", "Which rule?");
			await tui.terminal.chooseRow("1. /a -> work");
			await tui.terminal.waitForScreen((screen) => screen.includes("to which position"));
			tui.terminal.type("2");
			tui.terminal.press(ESC);
			await closed(tui, "to which position");
			assert.deepEqual(saved(tui).places, CONFIG.places);
		}));
});

describe("/guard place add under the keys of pi's real TUI", () => {
	it("shows which zone decides this place, asks what to match and which zone to give, and writes the rule first", () =>
		withTui(async (tui) => {
			const first = await tui.terminal.runCommand("/guard place add", "What should the new rule match?");
			assert.match(first, /personal \(default zone\)/, "the first dialog says which zone decides this place today");
			await tui.terminal.chooseRow("This directory and below");
			const zones = await tui.terminal.waitForScreen((screen) => screen.includes("Which zone does the new rule give?") && screen.includes("spare"));
			assert.match(zones, /→ work\s*\n\s+personal\s*\n\s+lab\s*\n\s+spare/, "every declared zone is a row, in order");
			await tui.terminal.chooseRow("work");
			await tui.terminal.waitForScreen((screen) => screen.includes("Added rule 1:"));
			assert.deepEqual(saved(tui).places, [{ path: tui.place, zone: "work" }, ...CONFIG.places]);
		}));

	it("Escape at either question adds nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard place add", "What should the new rule match?");
			tui.terminal.press(ESC);
			await closed(tui, "What should the new rule match?");
			assert.deepEqual(saved(tui).places, CONFIG.places);
			await tui.terminal.runCommand("/guard place add", "What should the new rule match?");
			await tui.terminal.chooseRow("This directory and below");
			await tui.terminal.waitForScreen((screen) => screen.includes("Which zone does the new rule give?"));
			tui.terminal.press(ESC);
			await closed(tui, "Which zone does the new rule give?");
			assert.deepEqual(saved(tui).places, CONFIG.places);
		}));
});

describe("/guard zone remove under the keys of pi's real TUI", () => {
	it("removes a zone nothing refers to", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone remove", "Which zone do you remove?");
			await tui.terminal.chooseRow("spare");
			await closed(tui, "Which zone do you remove?");
			assert.deepEqual(saved(tui).zones, ["work", "personal", "lab"]);
		}));

	it("refuses a zone that a tag or a rule still refers to, and names what refers to it", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone remove", "Which zone do you remove?");
			await tui.terminal.chooseRow("work");
			const screen = await tui.terminal.waitForScreen((current) => current.includes("did not remove zone work. It is still referenced by:"));
			assert.match(screen, /tag stub \(fallback\)/);
			assert.match(screen, /rule 1: \/a -> work/);
			assert.deepEqual(saved(tui).zones, CONFIG.zones);
		}));
});

describe("/guard zone rename and default under the keys of pi's real TUI", () => {
	it("rename asks which zone, then for the new name, and the config holds the new name", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone rename", "Which zone do you rename?");
			await tui.terminal.chooseRow("spare");
			await tui.terminal.waitForScreen((screen) => screen.includes("New name of zone spare?"));
			tui.terminal.answer("extra");
			await closed(tui, "New name of zone");
			assert.deepEqual(saved(tui).zones, ["work", "personal", "lab", "extra"]);
		}));

	it("default asks to confirm, says what it does to this place, and Yes sets the chosen zone", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone default", "Which zone is the default?");
			await tui.terminal.chooseRow("lab");
			const confirm = await tui.terminal.waitForScreen((screen) => screen.includes("Change the default zone to lab?") && screen.includes("→ Yes"));
			assert.match(confirm, /It is personal now\./);
			assert.match(confirm, /This place changes from zone personal to zone lab\./, "the confirm names the effect on the current place");
			tui.terminal.press("\r");
			await closed(tui, "Change the default zone to lab?");
			assert.equal(saved(tui).defaultZone, "lab");
		}));

	it("default answered No leaves the default zone alone", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone default", "Which zone is the default?");
			await tui.terminal.chooseRow("lab");
			await tui.terminal.waitForScreen((screen) => screen.includes("Change the default zone to lab?") && screen.includes("→ Yes"));
			await tui.terminal.chooseRow("No");
			await closed(tui, "Change the default zone to lab?");
			assert.equal(saved(tui).defaultZone, "personal");
		}));

	it("default on the zone that already is the default says so and changes nothing", () =>
		withTui(async (tui) => {
			await tui.terminal.runCommand("/guard zone default", "Which zone is the default?");
			await tui.terminal.chooseRow("personal");
			await tui.terminal.waitForScreen((screen) => screen.includes("The default zone is already personal."));
			assert.equal(saved(tui).defaultZone, "personal");
		}));
});
