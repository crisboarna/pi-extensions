// Layer B: `/tier tour` and the footer under the keys of pi's real TUI. Real interactive pi runs in this process on a
// virtual terminal. The tour is a series of pi selects (Next, Close); the footer and the decision line come from a routed
// turn on `switchboard/auto`, whose classifier is unreachable here, so the turn takes the profile's fallback tier.
//
// covers: src/commands/tour.ts, src/runtime.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_CONFIG } from "../support/harness.ts";
import { TuiSession } from "../support/tui-session.ts";
import { TUI_REPLY } from "../support/tui-stub-provider.ts";

const ENTER = "\r";
const ESC = "\x1b";
const TOUR = /pi-switchboard tour (\d+)\/(\d+):/;
const ROUTED = { provider: "switchboard", id: "auto" } as const;
const FOOTER = "work · standard · mid · fallback";

const currentStep = (screen: string): number | undefined => {
	const match = TOUR.exec(screen);
	return match ? Number(match[1]) : undefined;
};
const waitForStep = (tui: TuiSession, step: number, timeoutMs?: number) => tui.terminal.waitForScreen((screen) => currentStep(screen) === step, timeoutMs);
const tourClosed = (tui: TuiSession) => tui.terminal.waitForScreen((screen) => currentStep(screen) === undefined);

/** Types `/tier tour`. The first Enter may only close pi's command completion, so Enter is pressed until step 1 is up. */
async function openTour(tui: TuiSession): Promise<void> {
	tui.terminal.type("/tier tour");
	await tui.waitForEditor((text) => text === "/tier tour");
	for (let attempt = 0; attempt < 3; attempt++) {
		tui.terminal.press(ENTER);
		const opened = await waitForStep(tui, 1, 500).then(
			() => true,
			() => false,
		);
		if (opened) return;
	}
	throw new Error(`the tour did not open:\n${await tui.terminal.screen()}`);
}

async function withTui(body: (tui: TuiSession) => Promise<void>, options: { model?: { provider: string; id: string } } = {}): Promise<void> {
	const tui = await TuiSession.start({ config: BASE_CONFIG, ...(options.model ? { model: options.model } : {}) });
	try {
		await tui.ready();
		await body(tui);
	} finally {
		await tui.close();
	}
}

describe("the tour under the keys of pi's real TUI", () => {
	it("steps through every step with Enter on Next, and the last step offers only Close", () =>
		withTui(async (tui) => {
			await openTour(tui);
			const total = Number(TOUR.exec(await tui.terminal.screen())?.[2]);
			assert.ok(total >= 2, "the tour has several steps");
			assert.match(await tui.terminal.screen(), /→ Next →/);
			for (let step = 2; step <= total; step++) {
				tui.terminal.press(ENTER);
				await waitForStep(tui, step);
			}
			const last = (await tui.terminal.screen())
				.split("\n")
				.filter((row) => row.trim())
				.slice(-8)
				.join("\n");
			assert.doesNotMatch(last, /Next →/, "the last step has no Next row");
			assert.match(last, /Close/);
			tui.terminal.press(ENTER);
			await tourClosed(tui);
		}));

	it("Escape closes it from the middle, and the editor takes keys again", () =>
		withTui(async (tui) => {
			await openTour(tui);
			tui.terminal.press(ENTER);
			await waitForStep(tui, 2);
			tui.terminal.press(ESC);
			await tourClosed(tui);
			tui.terminal.type("x");
			await tui.waitForEditor((text) => text === "x");
		}));
});

describe("the footer under pi's real TUI", () => {
	it("shows no tier footer on a routed session before the first turn", () =>
		withTui(
			async (tui) => {
				assert.ok(!(await tui.terminal.screen()).includes(FOOTER));
			},
			{ model: ROUTED },
		));

	it("after a routed turn shows the decision line and the footer with the profile, tier, model and why", () =>
		withTui(
			async (tui) => {
				tui.terminal.type("rename foo to bar");
				await tui.waitForEditor((text) => text === "rename foo to bar");
				tui.terminal.press(ENTER);
				await tui.terminal.waitForScreen((screen) => screen.includes(TUI_REPLY));
				const screen = await tui.terminal.screen();
				assert.match(screen, /⇄ task 1 · fallback · standard → mid:medium \(ordered\)/);
				assert.ok(screen.includes(FOOTER), `the footer reads "${FOOTER}":\n${screen}`);
			},
			{ model: ROUTED },
		));

	it("shows no tier footer for a plain model that was never routed", () =>
		withTui(async (tui) => {
			tui.terminal.type("hello");
			await tui.waitForEditor((text) => text === "hello");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(TUI_REPLY));
			assert.ok(!(await tui.terminal.screen()).includes("work · standard"));
		}));
});
