// Layer B: the package beside other extensions, in a real pi session. Extensions share a few single-owner places: one editor, one
// `input` pipeline, one status line. These tests load pi's own example extensions (`test/support/neighbours.ts`), which use those
// places, in both orders where the order decides who wins, and check what the person sees and what the model receives.
//
// covers: src/pi/editor.ts, src/pi/running.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CustomEditor, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { neighbour } from "../support/neighbours.ts";
import { QUIET_REPLY, type Received } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const SLOW = { name: "slow", kind: "dynamic", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], timeout: 120 };
const LIBRARY = { version: 1, refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }, SLOW] };
/**
 * The rainbow editor draws each letter of "ultrathink" in its own 24-bit colour, and its shine brightens the first letters on some
 * frames, so no one colour is certain; a `u` and an `l` side by side that each carry their own colour are there on every frame, and
 * pi's theme never draws text that way.
 */
const COLOUR = String.raw`\x1b\[38;2;\d+;\d+;\d+m`;
const RAINBOW_LETTERS = new RegExp(`${COLOUR}u${COLOUR}l`);

type Order = "before" | "after";

async function withNeighbour(
	neighbourOrFactory: string | ExtensionFactory,
	order: Order,
	body: (tui: TuiSession, received: () => Received[]) => Promise<void>,
): Promise<void> {
	const factory: ExtensionFactory = typeof neighbourOrFactory === "string" ? await neighbour(neighbourOrFactory) : neighbourOrFactory;
	const log = join(mkdtempSync(join(tmpdir(), "context-refs-received-")), "received.jsonl");
	const received = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Received)
			: [];
	const started: Array<ReturnType<typeof setInterval>> = [];
	const realSetInterval = globalThis.setInterval;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
		const timer = realSetInterval(...args);
		started.push(timer);
		return timer;
	}) as typeof setInterval;
	const tui = await TuiSession.start({
		library: LIBRARY,
		env: { STUB_QUIET: "1", STUB_RECEIVED_LOG: log },
		...(order === "before" ? { before: [factory] } : { extensions: [factory] }),
	});
	try {
		await tui.ready();
		await body(tui, received);
	} finally {
		await tui.close();
		// pi's rainbow-editor starts an animation timer when "ultrathink" is typed and stops it only when the editor it started in
		// next gets a key; if that editor was replaced first (the order depends on load) the timer runs for ever and keeps the
		// test process alive after the last test. Clear what the neighbours started.
		globalThis.setInterval = realSetInterval;
		for (const timer of started) clearInterval(timer);
	}
}

/** True once a word in the editor was drawn by the rainbow editor, so a test knows the neighbour's editor is the one in use. */
async function rainbowIsDrawing(tui: TuiSession): Promise<boolean> {
	tui.terminal.type("ultrathink");
	await tui.waitForEditor((text) => text === "ultrathink");
	// the editor draws on its next render, which a loaded machine can delay; wait for the colours rather than for a guessed time
	const deadline = Date.now() + 3000;
	while (!RAINBOW_LETTERS.test(tui.terminal.raw) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	const drawn = RAINBOW_LETTERS.test(tui.terminal.raw);
	for (let key = 0; key < "ultrathink".length; key++) tui.terminal.press(BACKSPACE);
	await tui.waitForEditor((text) => text === "");
	return drawn;
}

describe("beside an extension that replaces the editor (pi's rainbow-editor example)", () => {
	it("loaded before the package: the package wraps that editor, a Placeholder stays one unit, and the send expands it", () =>
		withNeighbour("rainbow-editor", "before", async (tui, received) => {
			assert.ok(await rainbowIsDrawing(tui), "the neighbour's editor is the one in use");
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(BACKSPACE);
			await tui.waitForEditor((text) => text === "one");
			tui.terminal.type("[ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(received(), [{ text: "one Answer in one sentence.", images: 0 }]);
		}));

	it("loaded after the package: the package wraps that editor one tick later, a Placeholder stays one unit, and the send expands it", () =>
		withNeighbour("rainbow-editor", "after", async (tui, received) => {
			assert.ok(await rainbowIsDrawing(tui), "the neighbour's editor is the one in use");
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(BACKSPACE);
			await tui.waitForEditor((text) => text === "one");
			tui.terminal.type("[ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(received(), [{ text: "one Answer in one sentence.", images: 0 }]);
		}));
});

/** An extension that replaces the editor with a plain one 100 ms after the session starts, later than the package's wrap, without wrapping ours. */
function lateReplacer(swapped: { done: boolean }): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", (_event, ctx) => {
			setTimeout(() => {
				ctx.ui.setEditorComponent((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings));
				swapped.done = true;
			}, 100);
		});
	};
}

describe("beside an extension that replaces the editor later than the package wraps it", () => {
	async function withLateReplacer(body: (tui: TuiSession, received: () => Received[]) => Promise<void>): Promise<void> {
		const swapped = { done: false };
		await withNeighbour(lateReplacer(swapped), "after", async (tui, received) => {
			while (!swapped.done) await new Promise((resolve) => setTimeout(resolve, 20));
			await new Promise((resolve) => setTimeout(resolve, 200));
			await body(tui, received);
		});
	}

	it("loses the decoration: Backspace removes one character, and a typed Placeholder still expands", () =>
		withLateReplacer(async (tui, received) => {
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(BACKSPACE);
			await tui.waitForEditor((text) => text === "one [ref:terse", 5000);
			tui.terminal.type("]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(received(), [{ text: "one Answer in one sentence.", images: 0 }]);
		}));

	it("a Placeholder typed right after a half-deleted one still expands", () =>
		withLateReplacer(async (tui, received) => {
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(BACKSPACE);
			await tui.waitForEditor((text) => text === "one [ref:terse");
			tui.terminal.type("[ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse[ref:terse]");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(received(), [{ text: "one [ref:terseAnswer in one sentence.", images: 0 }]);
		}));
});

describe("beside an extension that rewrites input (pi's input-transform example)", () => {
	for (const order of ["before", "after"] as const) {
		it(`loaded ${order} the package: a ?quick prefix is rewritten and the Placeholder in it is still expanded`, () =>
			withNeighbour("input-transform", order, async (tui, received) => {
				tui.terminal.type("?quick explain [ref:terse]");
				await tui.waitForEditor((text) => text === "?quick explain [ref:terse]");
				tui.terminal.press(ENTER);
				await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
				assert.deepEqual(received(), [{ text: "Respond briefly in 1-2 sentences: explain Answer in one sentence.", images: 0 }]);
			}));
	}
});

describe("beside an extension that owns a status key (pi's status-line example)", () => {
	it("shows both statuses while a command ref runs, and only the neighbour's after Escape cancels it", () =>
		withNeighbour("status-line", "after", async (tui, received) => {
			await tui.terminal.waitForScreen((screen) => screen.includes("Ready"));
			tui.terminal.type("Wait [ref:slow]");
			await tui.waitForEditor((text) => text === "Wait [ref:slow]");
			tui.terminal.press(ENTER);
			const running = await tui.terminal.waitForScreen((screen) => screen.includes("running #slow"));
			assert.match(running, /running #slow… \(esc cancels\)/);
			assert.ok(running.includes("Ready"), "the neighbour's status is still shown");

			tui.terminal.press(ESC);
			const cancelled = await tui.terminal.waitForScreen((screen) => screen.includes("cancelled") && !screen.includes("running #slow"));
			assert.ok(cancelled.includes("Ready"), "the neighbour's status survived");
			assert.deepEqual(received(), []);
		}));
});

describe("the neighbour loader", () => {
	it("names the missing example when pi stops shipping it", async () => {
		await assert.rejects(neighbour("no-such-example"), /pi no longer ships examples\/extensions\/no-such-example\.ts/);
	});
});
