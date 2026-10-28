// Child processes for the end-to-end suites: each one's output is kept in
// memory for assertions and written to a log in the run folder.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { waitFor } from "./run.ts";

export interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
	/** stdout then stderr, with terminal escapes and carriage returns removed. */
	text: string;
}

export interface Proc {
	readonly child: ChildProcess;
	/** Everything printed so far, stdout and stderr interleaved, escapes removed. */
	output(): string;
	/** Resolves once the output matches `pattern`; fails if the process ends first or after `timeoutMs`. */
	waitForOutput(pattern: RegExp, timeoutMs: number): Promise<void>;
	/** Resolves when the process has exited. */
	readonly done: Promise<Result>;
	/** Sends `signal` (SIGINT is Ctrl+C) and waits for the exit, then SIGKILL after 15 s. */
	stop(signal?: NodeJS.Signals): Promise<Result>;
}

export interface StartOptions {
	env: Record<string, string>;
	cwd?: string;
	/** Log file for everything the process prints. */
	log: string;
	/** Text written to stdin, which is then closed; without it stdin is /dev/null. */
	stdin?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences, which start with ESC.
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\r/gu;
export const plain = (text: string) => text.replace(ESCAPES, "");

/** Starts `command` with `args`; nothing goes through a shell unless the command is `sh`. */
export function start(command: string, args: readonly string[], options: StartOptions): Proc {
	const child = spawn(command, args, {
		env: options.env,
		cwd: options.cwd,
		stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	const log = createWriteStream(options.log);
	log.write(`$ ${[command, ...args].join(" ")}\n`);
	let stdout = "";
	let stderr = "";
	let both = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
		both += chunk;
		log.write(chunk);
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
		both += chunk;
		log.write(chunk);
	});
	if (options.stdin !== undefined) child.stdin?.end(options.stdin);
	let exited = false;
	const done = new Promise<Result>((resolve) => {
		const finish = (code: number | null) => {
			exited = true;
			log.end(`\n[exit ${code}]\n`);
			resolve({ code, stdout, stderr, text: plain(`${stdout}${stderr}`) });
		};
		child.on("error", (error) => {
			stderr += `${error.message}\n`;
			finish(null);
		});
		child.on("close", finish);
	});
	return {
		child,
		output: () => plain(both),
		done,
		async waitForOutput(pattern, timeoutMs) {
			await waitFor(
				`${command} to print ${pattern}`,
				() => {
					if (pattern.test(plain(both))) return true;
					if (exited) throw new Error(`${command} exited before printing ${pattern}:\n${plain(both).slice(-2000)}`);
					return false;
				},
				timeoutMs,
			);
		},
		async stop(signal = "SIGTERM") {
			if (!exited) child.kill(signal);
			const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
			const result = await done;
			clearTimeout(kill);
			return result;
		},
	};
}

/** Runs `command` to completion, failing after `timeoutMs`. */
export async function run(command: string, args: readonly string[], options: StartOptions & { timeoutMs?: number }): Promise<Result> {
	const proc = start(command, args, options);
	const timer = setTimeout(() => proc.child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
	const result = await proc.done;
	clearTimeout(timer);
	return result;
}
