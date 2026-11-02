// The package beside real third-party extensions, in real pi, in both load orders. `test/tui/neighbours-keys.test.ts` does this with the
// example extensions pi ships; these are extensions people install, which the repository does not hold: `npm run coexist` at the
// repository root installs the versions pinned in scripts/coexist.json into a temporary folder and runs this file against them.
// Run on its own, it skips.
//
// What the person's editor does is read from what the model receives, not from the screen, because one of these extensions draws its
// own prompt in front of the typed text. Two things are checked for every extension and order:
//   1. a plain message gets through with the extension loaded;
//   2. a Placeholder typed in the editor, one Backspace, then the character that closes it: if the package's decoration holds, the
//      Placeholder is one unit and one Backspace removes all of it (the model gets "one ]"); if the extension replaced the editor
//      after the package, Backspace removes one character and the send still expands the Placeholder (DESIGN.md, load order).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { QUIET_REPLY, type Received } from "../support/stub-provider.ts";
import { COEXIST_DIR, installed } from "../support/third-party.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const BACKSPACE = "\x7f";
const LIBRARY = { version: 1, refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }] };

type Outcome = "one unit" | "one character";
/** What one Backspace removes from a Placeholder, per extension and order, as observed against the pinned versions. */
const NEIGHBOURS: Record<string, { before: Outcome; after: Outcome }> = {
	// wraps whatever editor is installed, on a timer, so it decorates the package's editor in both orders
	"pi-cc-steer": { before: "one unit", after: "one unit" },
	// replaces the editor when loaded after the package; loaded before, the package wraps its editor
	"pi-image-view": { before: "one unit", after: "one character" },
	// always replaces the editor with its own, which draws a prompt in front of the text
	"pi-powerline-footer": { before: "one unit", after: "one character" },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the screen has stopped changing, because an extension may finish installing itself a tick after pi is ready. */
async function settled(tui: TuiSession): Promise<void> {
	const deadline = Date.now() + 8000;
	let previous = "";
	let stableFor = 0;
	while (stableFor < 10 && Date.now() < deadline) {
		const screen = await tui.terminal.screen();
		stableFor = screen === previous ? stableFor + 1 : 0;
		previous = screen;
		await sleep(50);
	}
}

async function withNeighbour(
	name: string,
	order: "before" | "after",
	body: (tui: TuiSession, send: (typed: () => void) => Promise<Received>) => Promise<void>,
): Promise<void> {
	const factory = await installed(name);
	const log = join(mkdtempSync(join(tmpdir(), "context-refs-received-")), "received.jsonl");
	const received = (): Received[] =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Received)
			: [];
	// an extension may start a timer it never stops; clear what it started once the session is closed, so that it cannot keep the run alive
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
	let replies = 0;
	try {
		await tui.ready();
		await settled(tui);
		/** Types with `typed`, sends, waits for the reply, and resolves with what the model received. */
		const send = async (typed: () => void): Promise<Received> => {
			const before = received().length;
			typed();
			tui.terminal.press(ENTER);
			replies++;
			await tui.terminal.waitForScreen((screen) => screen.split(QUIET_REPLY).length - 1 >= replies, 15_000);
			const sent = received()[before];
			assert.ok(sent, "the model received the message");
			return sent;
		};
		await body(tui, send);
	} finally {
		await tui.close();
		globalThis.setInterval = realSetInterval;
		for (const timer of started) clearInterval(timer);
	}
}

describe("the package beside real third-party extensions", { skip: COEXIST_DIR ? false : "run with `npm run coexist` at the repository root" }, () => {
	for (const [name, outcomes] of Object.entries(NEIGHBOURS)) {
		for (const order of ["before", "after"] as const) {
			const outcome = outcomes[order];
			const title =
				outcome === "one unit"
					? "a Placeholder stays one unit under Backspace"
					: "Backspace removes one character of a Placeholder and the send still expands it";
			it(`${name} loaded ${order} the package: a plain message gets through, and ${title}`, () =>
				withNeighbour(name, order, async (tui, send) => {
					const plain = await send(() => tui.terminal.type("hello"));
					assert.deepEqual(plain, { text: "hello", images: 0 });
					const placeholder = await send(() => {
						tui.terminal.type("one [ref:terse]");
						tui.terminal.press(BACKSPACE);
						tui.terminal.type("]");
					});
					assert.equal(placeholder.text, outcome === "one unit" ? "one ]" : "one Answer in one sentence.");
				}));
		}
	}
});
