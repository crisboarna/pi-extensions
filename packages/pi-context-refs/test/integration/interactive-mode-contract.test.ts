// Guards the assumption every test in `test/tui` rests on: pi's `InteractiveMode` draws into the `terminal`
// it is given and reads keys from it, and touches neither the process's stdout nor its stdin. A pi upgrade
// that breaks this fails here, in one place, instead of as a dozen timeouts. Never weaken it to pass an upgrade.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUB_MODEL } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

describe("pi's InteractiveMode on an injected terminal", () => {
	it("starts the terminal, draws into it, takes its keys, and keeps its frames off process.stdout", async () => {
		const written: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		const tui = await TuiSession.start({ env: { STUB_QUIET: "1" } });
		try {
			await tui.ready();
			assert.equal(tui.terminal.started, true, "pi called start() on the injected terminal");
			assert.ok(tui.terminal.raw.includes(STUB_MODEL), "pi drew its footer into the injected terminal");

			tui.terminal.press("typed");
			await tui.terminal.waitForScreen((screen) => screen.includes("typed"));

			tui.terminal.resize(60);
			await tui.terminal.waitForScreen((screen) => screen.includes(STUB_MODEL));
		} finally {
			await tui.close();
			process.stdout.write = original;
		}
		assert.equal(tui.terminal.stopped, true, "pi called stop() on the injected terminal");
		// `node --test` writes its own progress events through stdout, so the check is for pi's frames: escape sequences and its footer.
		const leaked = written.filter((chunk) => chunk.includes("\x1b[") || chunk.includes(STUB_MODEL));
		assert.deepEqual(leaked, [], "none of pi's drawing went to the process's stdout");
	});
});
