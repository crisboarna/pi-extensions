// The package beside real third-party extensions, in real pi, in both load orders. `test/tui/neighbours-keys.test.ts` does this with the
// example extensions pi ships; these are extensions people install, which the repository does not hold: `npm run coexist` at the
// repository root installs the versions pinned in scripts/coexist.json into a temporary folder and runs this file against them.
// Run on its own, it skips.
//
// What the person's editor does is read from what the model receives, not from the screen, because one of these extensions draws its
// own prompt in front of the typed text. Two things are checked for every extension and order:
//   1. a plain message gets through with the extension loaded;
//   2. a Placeholder typed in the editor, one Backspace, then the character that closes it: the package wraps the editor one tick after
//      the session starts, whichever extension installed it (ADR 0007), so the Placeholder is one unit and one Backspace removes all of
//      it and the model gets "one ]". An extension that replaces the editor later than that would lose the decoration (DESIGN.md);
//      test/tui/neighbours-keys.test.ts covers that case with an extension that swaps the editor after 100 ms.
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

/** The extensions `scripts/coexist.json` pins, and what each does to the editor slot. */
const NEIGHBOURS: Record<string, string> = {
	"pi-cc-steer": "wraps whatever editor is installed, on a timer of its own",
	"pi-image-view": "replaces the editor when loaded after the package",
	"pi-powerline-footer": "always replaces the editor with its own, which draws a prompt in front of the text",
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
	for (const [name, behaviour] of Object.entries(NEIGHBOURS)) {
		for (const order of ["before", "after"] as const) {
			it(`${name} (${behaviour}) loaded ${order} the package: a plain message gets through, and a Placeholder stays one unit under Backspace`, () =>
				withNeighbour(name, order, async (tui, send) => {
					const plain = await send(() => tui.terminal.type("hello"));
					assert.deepEqual(plain, { text: "hello", images: 0 });
					const placeholder = await send(() => {
						tui.terminal.type("one [ref:terse]");
						tui.terminal.press(BACKSPACE);
						tui.terminal.type("]");
					});
					assert.equal(placeholder.text, "one ]");
				}));
		}
	}
});
