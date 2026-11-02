// Layer B: a model change while a turn is running, under the keys of pi's real TUI. A rotator, a small extension that switches the
// model on `turn_start` the way a pool of accounts does, moves the session from an account that matches this place to one that does
// not. The guard aborts the turn, and once it is idle shows the Block selector: the previous account first and no "Allow once".
// The stub provider streams slowly (`STUB_DELAY_MS`) so the change lands in the middle of the turn.
//
// covers: src/pi/mid-turn-block.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SECOND_PROVIDER } from "../support/second-provider.ts";
import { STUB_MODEL, STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const CONFIG = {
	zones: ["work", "personal"],
	defaultZone: "personal",
	accounts: [
		{ provider: STUB_PROVIDER, source: "fallback", zones: ["personal"] },
		{ provider: SECOND_PROVIDER, source: "fallback", zones: ["work"] },
	],
	places: [],
};
const BLOCK = "BLOCKED  stubtwo (fallback) is zone work";

/** Switches to the other account once, in the middle of the first turn. */
function rotator(pi: ExtensionAPI): void {
	let fired = false;
	pi.on("turn_start", async (_event, ctx) => {
		if (fired) return;
		fired = true;
		const target = ctx.modelRegistry.find(SECOND_PROVIDER, STUB_MODEL);
		if (target) await pi.setModel(target);
	});
}

async function withMidTurnBlock(body: (tui: TuiSession, requests: () => string[]) => Promise<void>): Promise<void> {
	const log = join(mkdtempSync(join(tmpdir(), "account-guard-requests-")), "requests.txt");
	const requests = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
	const tui = await TuiSession.start({ config: CONFIG, env: { STUB_DELAY_MS: "1200", STUB_REQUEST_LOG: log }, extensions: [rotator] });
	try {
		await tui.ready();
		tui.terminal.type("hello");
		await tui.waitForEditor((text) => text === "hello");
		tui.terminal.press(ENTER);
		await tui.terminal.waitForScreen((screen) => screen.includes(BLOCK) && screen.includes("Cancel"));
		await body(tui, requests);
	} finally {
		await tui.close();
	}
}

/** Long enough for the slow stub to have answered, if the aborted turn were wrongly resumed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1800));

describe("the mid-turn Block under the keys of pi's real TUI", () => {
	it("aborts the turn with a notice, then offers the previous account first, Allow for session and Cancel, but not Allow once", () =>
		withMidTurnBlock(async (tui) => {
			const screen = await tui.terminal.screen();
			assert.match(screen, /guard: failover blocked, model changed to stubtwo \(fallback\) \[work\] during a turn in a/);
			assert.match(screen, /Turn\s+aborted\./);
			assert.match(screen, /→ Switch to stub \(fallback\) -> stub-model {2}\[personal\]\s*\n\s+Allow for session: stubtwo \(fallback\)\s*\n\s+Cancel/);
			assert.ok(!screen.includes("Allow once"), "a change in the middle of a turn offers no Allow once");
			assert.match(screen, /guard personal ✗ stubtwo is work/, "the footer shows the Block");
		}));

	it("Cancel leaves the model on the blocked account, and the aborted turn is not resumed", () =>
		withMidTurnBlock(async (tui) => {
			await tui.terminal.chooseRow("Cancel");
			await tui.terminal.waitForScreen((screen) => !screen.includes(BLOCK));
			await settle();
			const screen = await tui.terminal.screen();
			assert.match(screen, /\(stubtwo\) stub-model/, "the model is still the blocked one");
			assert.match(screen, /guard personal ✗ stubtwo is work/);
			assert.ok(!screen.includes(STUB_REPLY), "no reply: the turn was aborted, not resumed");
		}));

	it("Switch puts the session back on the previous account at once, and the turn is still not resumed", () =>
		withMidTurnBlock(async (tui) => {
			await tui.terminal.chooseRow("Switch to stub");
			await tui.terminal.waitForScreen((screen) => /\(stub\) stub-model/.test(screen) && screen.includes("guard personal ✓"));
			await settle();
			assert.ok(!(await tui.terminal.screen()).includes(STUB_REPLY), "switching back does not resend the aborted prompt");
		}));

	it("Allow for session keeps the blocked account for the rest of the session, shown in the footer", () =>
		withMidTurnBlock(async (tui) => {
			await tui.terminal.chooseRow("Allow for session: stubtwo (fallback)");
			await tui.terminal.waitForScreen((screen) => screen.includes("guard OVERRIDE stubtwo in personal"));
			assert.match(await tui.terminal.screen(), /\(stubtwo\) stub-model/);
		}));
});
