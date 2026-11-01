import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandRequest, CommandResult } from "../../src/core/dynamic.ts";
import { createEscapeGuard } from "../../src/pi/escape-guard.ts";
import { createSendSet, trackRun } from "../../src/pi/running.ts";

const ESC = String.fromCharCode(27);

/** A TUI context that remembers its statuses and key listeners. */
function tui() {
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	const ctx = {
		mode: "tui",
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			onTerminalInput: (listener: (data: string) => { consume?: boolean } | undefined) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses, press: (data: string) => [...listeners].some((listener) => listener(data)?.consume === true), listeners };
}
/** A runner that finishes only when its request is aborted. */
const hangs = (request: CommandRequest): Promise<CommandResult> =>
	new Promise((resolve) => request.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: 0, killed: true })));
const request = (name: string): CommandRequest => ({ name, argv: [name], cwd: "/", timeoutMs: 1000, maxOutputBytes: 100 });
const noFetch = async (): Promise<never> => {
	throw new Error("no fetch");
};

describe("trackRun with several sends", () => {
	it("cancels every send in progress on one Esc, and gives each its own status", async () => {
		const t = tui();
		const sends = createSendSet();
		const first = trackRun(t.ctx, hangs, noFetch, sends);
		const second = trackRun(t.ctx, hangs, noFetch, sends);
		const running = [first.runCommand(request("a")), second.runCommand(request("b"))];
		const keys = new Set(t.statuses.map((status) => status.key));
		assert.equal(keys.size, 2, "two keys, so one send cannot clear the other's status");
		assert.equal(t.press(ESC), true);
		assert.deepEqual(
			(await Promise.all(running)).map((result) => result.killed),
			[true, true],
		);
		assert.equal(first.signal.aborted && second.signal.aborted, true);
	});

	it("leaves the Esc to another component while one wants it", async () => {
		const t = tui();
		const guard = createEscapeGuard();
		const sends = createSendSet(guard.taken);
		const run = trackRun(t.ctx, hangs, noFetch, sends);
		const running = run.runCommand(request("a"));
		const release = guard.hold();
		assert.equal(t.press(ESC), false, "the overlay keeps its Esc");
		assert.equal(run.signal.aborted, false);
		let listOpen = true;
		guard.watch(() => listOpen);
		release();
		assert.equal(t.press(ESC), false, "so does the autocomplete list");
		listOpen = false;
		assert.equal(t.press(ESC), true);
		assert.equal((await running).killed, true);
	});

	it("takes a finished send out of the set, so a later Esc does not reach it", async () => {
		const t = tui();
		const sends = createSendSet();
		const run = trackRun(t.ctx, async () => ({ stdout: "", stderr: "", code: 0, killed: false }), noFetch, sends);
		await run.runCommand(request("a"));
		run.finish();
		assert.equal(sends.active.size, 0);
		assert.equal(t.listeners.size, 0);
	});
});
