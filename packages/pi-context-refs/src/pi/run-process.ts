import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { CommandRequest, CommandResult } from "../core/dynamic.ts";

/** After SIGTERM, a command that has not exited gets SIGKILL this much later. */
const KILL_GRACE_MS = 2000;
/** After the process exits, output a detached descendant still holds open is given this long before it is dropped. */
const STREAM_GRACE_MS = 200;

/**
 * Runs `request.argv` with no shell and collects its output, never more than `request.maxOutputBytes + 1` bytes of it: a command that writes
 * without end is killed once it has written more than the cap, instead of filling memory. `overflow` is set when that happened. The promise
 * rejects when the program cannot start, with `startProblem` or the system's reason.
 */
export function runProcess(request: CommandRequest, startProblem: (program: string, cwd: string) => string | undefined): Promise<CommandResult> {
	const [program = "", ...args] = request.argv;
	const limit = request.maxOutputBytes + 1;
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { cwd: request.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let kept = 0;
		let seen = 0;
		let killed = false;
		let overflow = false;
		let settled = false;
		const timers: NodeJS.Timeout[] = [];

		const stop = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			timers.push(setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS));
		};
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			seen += chunk.length;
			const room = limit - kept;
			if (room > 0) {
				const piece = chunk.subarray(0, room);
				into.push(piece);
				kept += piece.length;
			}
			if (seen > limit && !overflow) {
				overflow = true;
				stop();
			}
		};
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				code: code ?? (signal === null ? 0 : 128 + (osConstants.signals[signal] ?? 0)),
				killed,
				...(overflow ? { overflow } : {}),
			});
		};
		const onAbort = () => {
			killed = true;
			stop();
		};

		child.stdout.on("data", collect(out));
		child.stderr.on("data", collect(err));
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			reject(new Error(startProblem(program, request.cwd) ?? error.message));
		});
		child.once("close", (code, signal) => finish(code, signal));
		child.once("exit", (code, signal) => timers.push(setTimeout(() => finish(code, signal), STREAM_GRACE_MS)));

		if (request.signal?.aborted) onAbort();
		else request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.timeoutMs > 0)
			timers.push(
				setTimeout(() => {
					killed = true;
					stop();
				}, request.timeoutMs),
			);
	});
}
