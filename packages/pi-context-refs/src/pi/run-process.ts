import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { CommandRequest, CommandResult } from "../core/dynamic.ts";

/** After SIGTERM, a command that has not exited gets SIGKILL this much later. */
const KILL_GRACE_MS = 2000;
/** After the process exits, output a detached descendant still holds open is given this long before it is dropped. */
const STREAM_GRACE_MS = 200;

/**
 * The process groups of commands still running. Each command leads its own group, so stopping it stops every process it started; the
 * same group is no longer killed with pi's terminal, so pi kills what is left when it exits.
 */
const running = new Set<number>();
const killRunning = () => {
	for (const pid of running) signalTree(pid, "SIGKILL");
};

function signalTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: the group has no processes left.
	}
}

function track(pid: number): void {
	if (running.size === 0) process.once("exit", killRunning);
	running.add(pid);
}

function untrack(pid: number): void {
	if (!running.delete(pid)) return;
	if (running.size === 0) process.removeListener("exit", killRunning);
}

/**
 * Runs `request.argv` with no shell and collects its output, never more than `request.maxOutputBytes + 1` bytes of it: a command that writes
 * without end is killed once it has written more than the cap, instead of filling memory. `overflow` is set when that happened. The promise
 * rejects when the program cannot start, with `startProblem` or the system's reason.
 *
 * A command runs as the leader of its own process group. A timeout, an abort or the output cap stops the whole group, so a script's
 * children do not outlive it. A command that exits by itself leaves the processes it started running, as it would in a shell.
 */
export function runProcess(request: CommandRequest, startProblem: (program: string, cwd: string) => string | undefined): Promise<CommandResult> {
	const [program = "", ...args] = request.argv;
	const limit = request.maxOutputBytes + 1;
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { cwd: request.cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const pid = child.pid;
		if (pid !== undefined) track(pid);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let kept = 0;
		let seen = 0;
		let killed = false;
		let overflow = false;
		let settled = false;
		const timers: NodeJS.Timeout[] = [];

		let stopping = false;
		const stop = () => {
			if (stopping || pid === undefined) return;
			stopping = true;
			signalTree(pid, "SIGTERM");
			timers.push(setTimeout(() => signalTree(pid, "SIGKILL"), KILL_GRACE_MS));
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
			if (pid !== undefined) {
				// A stopped command's group gets SIGKILL now: the SIGKILL timer was just cleared, and a child may have ignored SIGTERM.
				if (stopping) signalTree(pid, "SIGKILL");
				untrack(pid);
			}
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
			if (pid !== undefined) untrack(pid);
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
