// Layer B: the last two "Keystrokes" lines of docs/manual-checklist.md as tests. A pick from `alt+r` after a typed
// `#te` replaces the `#te` and leaves no stray character; Esc during a slow command ref cancels the send and puts
// the draft back. The pty versions in `test/smoke` stay as canaries against the shipped binary.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { QUIET_REPLY, type Received } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const ALT_R = "\x1br";
const SLOW = { name: "slow", kind: "dynamic", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], timeout: 120 };
const LIBRARY = {
	version: 1,
	refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence.", description: "Keep answers short" }, SLOW],
};

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

describe("the alt+r overlay under the keys of pi's real editor", () => {
	it("replaces the typed #te on a pick, with no stray character, and the sent message is expanded", () =>
		withTui(async (tui, received) => {
			tui.terminal.type("see #te");
			await tui.terminal.waitForScreen((screen) => screen.includes("● terse"));
			tui.terminal.press(ALT_R);
			const open = await tui.terminal.waitForScreen((screen) => screen.includes("Context refs") && screen.includes("── preview · terse"));
			assert.match(open, /filter: te/);

			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => !screen.includes("Context refs"));
			assert.equal(await tui.editor(), "see [ref:terse]", "the #te became the Placeholder and nothing else was added");

			tui.terminal.type(" now");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(received(), [{ text: "see Answer in one sentence. now", images: 0 }]);
		}));
});

describe("Esc during a slow command ref in pi's real editor", () => {
	it("cancels the send, puts the draft back, and sends nothing to the model", () =>
		withTui(async (tui, received) => {
			tui.terminal.type("Wait for [ref:slow]");
			await tui.waitForEditor((text) => text === "Wait for [ref:slow]");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("running #slow"));

			tui.terminal.press(ESC);
			const screen = await tui.terminal.waitForScreen((text) => text.includes("cancelled"));
			assert.equal(screen.includes("running #slow"), false, "the status is gone");
			assert.equal(await tui.editor(), "Wait for [ref:slow]", "the draft is back");
			assert.deepEqual(received(), [], "no request reached the model");
		}));
});
