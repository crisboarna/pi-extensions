import { isBuiltin } from "./builtins.ts";
import { contextBlock, failureNote, sanitizeText } from "./context-block.ts";
import type { DynamicRef } from "./library.ts";

/** A Dynamic Ref whose Source is a command. */
export type CommandRef = DynamicRef & { command: string[] };

/** What one run of a command asks of the runner. `timeoutMs` is how long it may take before the runner kills it. */
export interface CommandRequest {
	name: string;
	argv: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** What a finished command left behind, in the shape of `pi.exec`. `killed` is set when the runner stopped it, after a timeout or an abort. */
export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** What running a command needs from outside. The runner rejects when the command cannot start, with the reason as the message. */
export interface CommandEnv {
	runCommand: (request: CommandRequest) => Promise<CommandResult>;
	/** Whether `cwd` is inside a git work tree. */
	isGitWorkTree: (cwd: string) => Promise<boolean>;
}

/** A Dynamic Ref's Context block, or its Failure note and the reason. */
export type DynamicBlock = { name: string; text: string } | { name: string; text: string; reason: string };

const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_OUTPUT = 50 * 1024;
const BINARY_PROBE_LENGTH = 8192;

export const isCommandRef = (ref: { kind: string; command?: string[] }): ref is CommandRef => ref.kind === "dynamic" && ref.command !== undefined;

/** The argv as one line, with the arguments that hold spaces, quotes or nothing in double quotes. It is for reading, not for running. */
export function commandText(argv: readonly string[]): string {
	return argv.map((argument) => (argument === "" || /[\s"'\\|&;<>$`*?()[\]{}~#]/.test(argument) ? JSON.stringify(argument) : argument)).join(" ");
}

/** Runs the Ref's command in `cwd` and builds its Context block. A non-zero exit and a cut are marked in the block; the other ways to fail give a Failure note. */
export async function dynamicBlock(ref: CommandRef, cwd: string, env: CommandEnv, signal?: AbortSignal): Promise<DynamicBlock> {
	const source = commandText(ref.command);
	const fail = (reason: string): DynamicBlock => ({ name: ref.name, reason, text: failureNote({ name: ref.name, kind: "dynamic", source, error: reason }) });
	if (isBuiltin(ref) && !(await env.isGitWorkTree(cwd))) return fail("not a git repository");

	const timeout = ref.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	let result: CommandResult;
	try {
		result = await env.runCommand({ name: ref.name, argv: ref.command, cwd, timeoutMs: timeout * 1000, ...(signal ? { signal } : {}) });
	} catch (error) {
		return fail(`${source} cannot start: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (result.killed) return fail(signal?.aborted ? `${source} was cancelled` : `${source} timed out after ${timeout} s`);

	const output = result.stdout + (result.stderr === "" || result.stdout === "" || result.stdout.endsWith("\n") ? "" : "\n") + result.stderr;
	if (output.slice(0, BINARY_PROBE_LENGTH).includes("\0")) return fail(`${source} wrote binary output`);

	const cap = ref.max_output ?? DEFAULT_MAX_OUTPUT;
	const { bytes, cut } = headBytes(output, cap);
	const truncated = cut ? sizeLabel(cap) : undefined;
	const marks = [result.code === 0 ? undefined : `exit ${result.code}`, truncated === undefined ? undefined : `truncated at ${truncated}`].filter(
		(mark) => mark !== undefined,
	);
	const line = `$ ${source}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
	const text = sanitizeText(bytes);
	const body = text === "" ? line : `${line}\n${text}`;
	return {
		name: ref.name,
		text: contextBlock({
			name: ref.name,
			kind: "dynamic",
			source,
			body,
			...(result.code === 0 ? {} : { exit: result.code }),
			...(truncated === undefined ? {} : { truncated }),
		}),
	};
}

/** The first `cap` bytes of `text` in UTF-8, ending on a character boundary. */
function headBytes(text: string, cap: number): { bytes: Uint8Array; cut: boolean } {
	const all = Buffer.from(text, "utf8");
	if (all.length <= cap) return { bytes: all, cut: false };
	let end = cap;
	// A continuation byte (10xxxxxx) at the cut means the cut splits a character.
	while (end > 0 && ((all[end] ?? 0) & 0xc0) === 0x80) end--;
	return { bytes: all.subarray(0, end), cut: true };
}

function sizeLabel(bytes: number): string {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
	return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;
}
