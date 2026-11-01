import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandRequest } from "../../src/core/dynamic.ts";
import { runProcess } from "../../src/pi/run-process.ts";

const node = (script: string, extra: Partial<CommandRequest> = {}): CommandRequest => ({
	name: "t",
	argv: [process.execPath, "-e", script],
	cwd: process.cwd(),
	timeoutMs: 10_000,
	maxOutputBytes: 1000,
	...extra,
});
const noProblem = () => undefined;
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("runProcess", () => {
	it("returns the output and the exit code of a command that finishes", async () => {
		const result = await runProcess(node("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"), noProblem);
		assert.deepEqual(result, { stdout: "out", stderr: "err", code: 3, killed: false });
	});

	it("gives a command that something else killed a failing exit code, not a success", async () => {
		const result = await runProcess(node("process.kill(process.pid, 'SIGKILL')"), noProblem);
		assert.equal(result.killed, false);
		assert.equal(result.code, 137);
	});

	it("stops a command that writes without end, keeping a little more than the cap", async () => {
		const result = await runProcess(node("setInterval(() => process.stdout.write('x'.repeat(65536)), 0)"), noProblem);
		assert.equal(result.overflow, true);
		assert.equal(result.killed, false);
		assert.ok(result.stdout.length > 1000 && result.stdout.length <= 1001, `kept ${result.stdout.length} bytes`);
	});

	it("counts the two streams together", async () => {
		const result = await runProcess(
			node("process.stdout.write('a'.repeat(600)); process.stderr.write('b'.repeat(600)); setTimeout(() => {}, 60000)"),
			noProblem,
		);
		assert.equal(result.overflow, true);
	});

	it("does not set overflow for output of exactly the cap", async () => {
		const result = await runProcess(node("process.stdout.write('a'.repeat(1000))"), noProblem);
		assert.equal(result.overflow, undefined);
		assert.equal(result.stdout.length, 1000);
	});

	it("kills a command at its timeout", async () => {
		const result = await runProcess(
			node("require('node:fs').writeSync(1, String(process.pid)); setTimeout(() => {}, 60000)", { timeoutMs: 300 }),
			noProblem,
		);
		assert.equal(result.killed, true);
		assert.equal(alive(Number(result.stdout)), false);
	});

	it("kills a command when the signal aborts, and at once when it was aborted already", async () => {
		const controller = new AbortController();
		const running = runProcess(node("setTimeout(() => {}, 60000)", { signal: controller.signal }), noProblem);
		setTimeout(() => controller.abort(), 100);
		assert.equal((await running).killed, true);
		assert.equal((await runProcess(node("setTimeout(() => {}, 60000)", { signal: AbortSignal.abort() }), noProblem)).killed, true);
	});

	it("rejects with the reason a program cannot start", async () => {
		const request = { ...node(""), argv: ["context-refs-no-such-program"] };
		await assert.rejects(
			runProcess(request, (program) => `${program} was not found`),
			{ message: "context-refs-no-such-program was not found" },
		);
		await assert.rejects(runProcess(request, noProblem), { message: /ENOENT/u });
	});
});
