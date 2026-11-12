import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

	describe("the processes a command started", () => {
		// The command starts one child that writes its pid and then sleeps. `ignoreTerm` makes that child survive SIGTERM.
		const withChild = (rest: string, ignoreTerm = false) =>
			`const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
				`${ignoreTerm ? "process.on('SIGTERM', () => {}); " : ""}setTimeout(() => {}, 60000)`,
			)}], { stdio: 'ignore' }); c.unref(); require('node:fs').writeSync(1, String(c.pid) + '\\n'); ${rest}`;
		const childPid = (stdout: string): number => Number(stdout.split("\n")[0]);
		const goneWithin = async (pid: number, ms: number): Promise<boolean> => {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				if (!alive(pid)) return true;
				await new Promise((settle) => setTimeout(settle, 25));
			}
			return !alive(pid);
		};
		const reap = (pid: number) => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};

		it("are stopped with the command at its timeout", async () => {
			const result = await runProcess(node(withChild("setTimeout(() => {}, 60000)"), { timeoutMs: 300 }), noProblem);
			const pid = childPid(result.stdout);
			assert.equal(result.killed, true);
			assert.equal(await goneWithin(pid, 2000), true, `child ${pid} outlived the timeout`);
			reap(pid);
		});

		it("are stopped with the command when the signal aborts", async () => {
			const controller = new AbortController();
			const running = runProcess(node(withChild("setTimeout(() => {}, 60000)"), { signal: controller.signal }), noProblem);
			setTimeout(() => controller.abort(), 300);
			const result = await running;
			const pid = childPid(result.stdout);
			assert.equal(result.killed, true);
			assert.equal(await goneWithin(pid, 2000), true, `child ${pid} outlived the abort`);
			reap(pid);
		});

		it("are stopped with a command that writes past the cap", async () => {
			const result = await runProcess(node(withChild("setInterval(() => process.stdout.write('x'.repeat(65536)), 0)")), noProblem);
			const pid = childPid(result.stdout);
			assert.equal(result.overflow, true);
			assert.equal(await goneWithin(pid, 2000), true, `child ${pid} outlived the overflow`);
			reap(pid);
		});

		it("are stopped even when they ignore SIGTERM and the command does not", async () => {
			const result = await runProcess(node(withChild("setTimeout(() => {}, 60000)", true), { timeoutMs: 300 }), noProblem);
			const pid = childPid(result.stdout);
			assert.equal(result.killed, true);
			assert.equal(await goneWithin(pid, 2000), true, `child ${pid} survived SIGTERM and was never sent SIGKILL`);
			reap(pid);
		});

		it("are stopped with SIGKILL when the command itself ignores SIGTERM", async () => {
			const result = await runProcess(node(withChild("process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"), { timeoutMs: 300 }), noProblem);
			const pid = childPid(result.stdout);
			assert.equal(result.killed, true);
			assert.equal(result.code, 137);
			assert.equal(await goneWithin(pid, 2000), true, `child ${pid} outlived the SIGKILL`);
			reap(pid);
		});

		it("are stopped when pi exits while the command is still running", async () => {
			// A host process starts a long command, prints the command's child pid, and exits without stopping it.
			const runner = new URL("../../src/pi/run-process.ts", import.meta.url).href;
			const host = `import { execFileSync } from "node:child_process";
				import { runProcess } from ${JSON.stringify(runner)};
				const script = ${JSON.stringify(withChild("setTimeout(() => {}, 60000)"))};
				runProcess({ name: "t", argv: [process.execPath, "-e", script], cwd: process.cwd(), timeoutMs: 0, maxOutputBytes: 1000 }, () => undefined);
				setTimeout(() => {
					const command = execFileSync("pgrep", ["-P", String(process.pid)]).toString().trim();
					process.stdout.write(execFileSync("pgrep", ["-P", command]).toString().trim());
					process.exit(0);
				}, 500);`;
			const out = execFileSync(process.execPath, ["--input-type=module", "-e", host]).toString();
			const pid = Number(out.trim());
			assert.ok(pid > 0, `host printed ${JSON.stringify(out)}`);
			assert.equal(await goneWithin(pid, 2000), true, `child ${pid} outlived pi`);
			reap(pid);
		});

		it("are left running when the command finishes by itself", async () => {
			const result = await runProcess(node(withChild("")), noProblem);
			const pid = childPid(result.stdout);
			assert.equal(result.killed, false);
			assert.equal(alive(pid), true, "a command that exits normally keeps the processes it started");
			reap(pid);
		});
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
