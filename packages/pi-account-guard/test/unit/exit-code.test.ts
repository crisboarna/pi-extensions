import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExitCodeKeeper, type ExitTarget } from "../../src/pi/exit-code.ts";

/** A stand-in for `process`: records the exit listeners and runs them on demand. */
function fakeProcess() {
	const listeners: Array<() => void> = [];
	const target: ExitTarget & { exit(): void; listenerCount(): number } = {
		exitCode: undefined,
		on: (_event, listener) => void listeners.push(listener),
		exit: () => {
			for (const listener of listeners) listener();
		},
		listenerCount: () => listeners.length,
	};
	return target;
}

describe("createExitCodeKeeper", () => {
	it("sets the exit code at once and sets it again at exit, after pi replaced it", () => {
		const target = fakeProcess();
		createExitCodeKeeper(target)(77);
		assert.equal(target.exitCode, 77);
		target.exitCode = 1;
		target.exit();
		assert.equal(target.exitCode, 77);
	});

	it("keeps the latest code and listens once", () => {
		const target = fakeProcess();
		const keep = createExitCodeKeeper(target);
		keep(77);
		keep(2);
		target.exitCode = 1;
		target.exit();
		assert.equal(target.exitCode, 2);
		assert.equal(target.listenerCount(), 1);
	});

	it("keeps nothing for a keeper that was never asked, so a second registration does not undo the first", () => {
		const target = fakeProcess();
		const first = createExitCodeKeeper(target);
		createExitCodeKeeper(target);
		first(77);
		target.exitCode = 1;
		target.exit();
		assert.equal(target.exitCode, 77);
		assert.equal(target.listenerCount(), 1);
	});
});
