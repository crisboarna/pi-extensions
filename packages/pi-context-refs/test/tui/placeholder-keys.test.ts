// Layer B: the "Keystrokes" lines of docs/manual-checklist.md that concern the Placeholder, as tests. Real pi's
// interactive mode runs in this process on a virtual terminal; each test types keys and reads the editor.
// The expected text is what the keys did when first tried, which is what the checklist describes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { QUIET_REPLY, type Received } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const BACKSPACE = "\x7f";
const CTRL_W = "\x17";
/** Pi's undo is `ctrl+-` (`ctrl+z` only on Windows), which a terminal sends as the byte US. */
const UNDO = "\x1f";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const LIBRARY = { version: 1, refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }] };

async function withTui(body: (tui: TuiSession, received: () => Received[]) => Promise<void>): Promise<void> {
	const log = join(mkdtempSync(join(tmpdir(), "context-refs-received-")), "received.jsonl");
	const received = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Received)
			: [];
	const tui = await TuiSession.start({ library: LIBRARY, env: { STUB_QUIET: "1", STUB_RECEIVED_LOG: log } });
	try {
		await tui.ready();
		await body(tui, received);
	} finally {
		await tui.close();
	}
}

describe("the Placeholder under the keys of pi's real editor", () => {
	it("is deleted whole by one Backspace", () =>
		withTui(async (tui) => {
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(BACKSPACE);
			await tui.waitForEditor((text) => text === "one");
		}));

	it("is jumped over whole by Left and by Right", () =>
		withTui(async (tui) => {
			tui.terminal.type("ab [ref:terse]");
			await tui.waitForEditor((text) => text === "ab [ref:terse]");
			tui.terminal.press(LEFT);
			tui.terminal.type("X");
			await tui.waitForEditor((text) => text === "ab X[ref:terse]");
			tui.terminal.press(RIGHT);
			tui.terminal.type("Y");
			await tui.waitForEditor((text) => text === "ab X[ref:terse]Y");
		}));

	it("is the only thing Ctrl+W deletes, and the word before it stays", () =>
		withTui(async (tui) => {
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(CTRL_W);
			await tui.waitForEditor((text) => text === "one");
		}));

	it("comes back whole after a delete and an undo", () =>
		withTui(async (tui) => {
			tui.terminal.type("one [ref:terse]");
			await tui.waitForEditor((text) => text === "one [ref:terse]");
			tui.terminal.press(BACKSPACE);
			await tui.waitForEditor((text) => text === "one");
			tui.terminal.press(UNDO);
			await tui.waitForEditor((text) => text === "one [ref:terse]");
		}));

	it("is recalled by Up-arrow after a send, and sends the same expansion again, not a second block", () =>
		withTui(async (tui, received) => {
			tui.terminal.type("with [ref:terse]");
			await tui.waitForEditor((text) => text === "with [ref:terse]");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.equal(await tui.editor(), "", "the send cleared the editor");

			tui.terminal.press(UP);
			await tui.waitForEditor((text) => text === "with [ref:terse]");
			tui.terminal.press(ENTER);
			await tui.waitForEditor((text) => text === "");
			const expected = { text: "with Answer in one sentence.", images: 0 };
			await tui.terminal.waitForScreen(() => received().length === 2);
			assert.deepEqual(received(), [expected, expected]);
		}));
});
