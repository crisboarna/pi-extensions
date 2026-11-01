// Layer B: real pi's interactive mode in this process, on a virtual terminal. Keys go in as bytes; the
// screen and what the model received come out. Runs in `npm run test:integration` with no pty and no binary.
//
// covers: src/pi/picker.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { QUIET_REPLY, type Received } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const LIBRARY = { version: 1, refs: [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }] };

function receivedLog(): { path: string; read(): Received[] } {
	const path = join(mkdtempSync(join(tmpdir(), "context-refs-received-")), "received.jsonl");
	const read = () =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Received)
			: [];
	return { path, read };
}

describe("typing a ref in pi's real editor", () => {
	it("picks a ref from the # list with Enter and sends it expanded", async () => {
		const log = receivedLog();
		const tui = await TuiSession.start({ library: LIBRARY, env: { STUB_QUIET: "1", STUB_RECEIVED_LOG: log.path } });
		try {
			await tui.ready();
			tui.terminal.press("first #te");
			await tui.terminal.waitForScreen((screen) => screen.includes("terse"));

			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes("first [ref:terse]"));

			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.deepEqual(log.read(), [{ text: "first Answer in one sentence.", images: 0 }]);
		} finally {
			await tui.close();
		}
	});
});
