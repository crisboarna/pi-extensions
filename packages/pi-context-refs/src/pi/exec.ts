import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandEnv, CommandRequest, CommandResult } from "../core/dynamic.ts";

/** `pi.exec`: runs a program with an argument list and no shell. */
export type Exec = ExtensionAPI["exec"];

const GIT_CHECK_TIMEOUT_MS = 5000;

/** Runs commands through `pi.exec`, and asks git whether a directory is inside a work tree. */
export function commandEnv(exec: Exec): CommandEnv {
	return {
		async runCommand(request: CommandRequest): Promise<CommandResult> {
			const [program = "", ...args] = request.argv;
			const result = await exec(program, args, { cwd: request.cwd, timeout: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) });
			// pi.exec reports a command that could not start as exit 1 with nothing written; a program that really exits 1 in silence looks the same, so look.
			if (result.code === 1 && !result.killed && result.stdout === "" && result.stderr === "") {
				const problem = startProblem(program, request.cwd);
				if (problem !== undefined) throw new Error(problem);
			}
			return result;
		},
		async isGitWorkTree(cwd: string): Promise<boolean> {
			const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: GIT_CHECK_TIMEOUT_MS });
			return result.code === 0 && result.stdout.trim() === "true";
		},
	};
}

/** Why `program` cannot start in `cwd`, or undefined when nothing explains it. */
function startProblem(program: string, cwd: string): string | undefined {
	if (!isDirectory(cwd)) return `the directory ${cwd} does not exist`;
	const candidates = program.includes("/") ? [resolve(cwd, program)] : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, program));
	return candidates.some(isExecutable) ? undefined : `${program} was not found`;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
