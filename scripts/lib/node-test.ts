// Runs `node --test` on some test files in a package folder and reports how it ended. A run that does not exit in time is killed with
// everything it started and reported as a hang, which is not the same as a failure: the suites in this repository once passed every test
// and then never exited, and only a timeout can see that.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface NodeTestRun {
	/** The exit code, or `undefined` when the run was killed because it did not exit in time. */
	exitCode: number | undefined;
	/** Whether the run was killed after the timeout. */
	hung: boolean;
	milliseconds: number;
}

/** The process groups of the runs in flight, so that a signal handler can stop them. */
const running = new Set<number>();

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// the group has already exited
	}
}

/** Kills every run in flight, with the processes it started. */
export function killRunningTests(): void {
	for (const pid of running) killGroup(pid);
	running.clear();
}

/** Runs the test `files` (paths relative to `cwd`) and writes everything they print to `logPath`. */
export function runNodeTest(options: { cwd: string; files: string[]; timeoutMs: number; logPath: string; env?: NodeJS.ProcessEnv }): Promise<NodeTestRun> {
	return new Promise((resolve) => {
		const started = Date.now();
		const log = createWriteStream(options.logPath);
		// a run started from inside another `node --test` would inherit this and report its failures as a nested run does: exit code 0
		const { NODE_TEST_CONTEXT: _outer, ...inherited } = process.env;
		// the spec reporter on every Node: before Node 24 a piped run prints TAP, which has no ✖ line to find in the log
		const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...options.files], {
			cwd: options.cwd,
			env: { ...inherited, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const pid = child.pid;
		if (pid !== undefined) running.add(pid);
		child.stdout.pipe(log, { end: false });
		child.stderr.pipe(log, { end: false });
		let hung = false;
		const timer = setTimeout(() => {
			hung = true;
			if (pid !== undefined) killGroup(pid);
		}, options.timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (pid !== undefined) running.delete(pid);
			log.end(() => resolve({ exitCode: hung ? undefined : (code ?? undefined), hung, milliseconds: Date.now() - started }));
		});
	});
}
