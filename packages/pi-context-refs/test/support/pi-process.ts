// Runs real pi for smoke tests: no network, no credentials, an isolated agent
// directory, and the stub provider loaded with `-ne -e`.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_MODEL, STUB_PROVIDER } from "./stub-provider.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const REPOSITORY_ROOT = join(ROOT, "..", "..");
export const STUB_EXTENSION = join(ROOT, "test", "support", "stub-provider.ts");
export const PROBE_EXTENSION = join(ROOT, "test", "support", "probe-extension.ts");

/** The pi executable: `PI_BIN` if set, else the repository's pinned pi, else `pi` from PATH. */
export const PI_BIN =
	process.env.PI_BIN ?? (existsSync(join(REPOSITORY_ROOT, "node_modules", ".bin", "pi")) ? join(REPOSITORY_ROOT, "node_modules", ".bin", "pi") : "pi");

const CREDENTIAL_ENV = /(?:API_KEY|TOKEN|SECRET|CREDENTIALS|AUTH)/i;
/** Variables that configure pi itself: a test run inside another pi session must not inherit that session's model, session file or subagent role. */
const PI_ENV = /^PI_/;

export interface PiOptions {
	/** Extension files to load besides the stub provider; defaults to the probe extension. */
	extensions?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Extra pi arguments before the mode arguments, for example `--tools +codemode`. */
	args?: string[];
}

/** An isolated environment: pi's own state in a temp directory, offline, with credential and pi configuration variables removed. */
export function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!CREDENTIAL_ENV.test(key) && !PI_ENV.test(key)) env[key] = value;
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-smoke-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	return { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...extra };
}

export function piArgs(options: PiOptions, mode: string[]): string[] {
	const extensions = [STUB_EXTENSION, ...(options.extensions ?? [PROBE_EXTENSION])];
	return [
		"-ne",
		...extensions.flatMap((path) => ["-e", path]),
		"--provider",
		STUB_PROVIDER,
		"--model",
		STUB_MODEL,
		"--no-session",
		"--no-skills",
		...(options.args ?? []),
		...mode,
	];
}

export interface PrintResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

/** Runs `pi -p <prompt>` to completion. */
export function runPrint(prompt: string, options: PiOptions = {}): Promise<PrintResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(PI_BIN, piArgs(options, ["-p", prompt]), {
			cwd: options.cwd ?? ROOT,
			env: isolatedEnv(options.env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code }));
	});
}

export type RpcRecord = { type: string; [key: string]: unknown };

/** A scripted `pi --mode rpc` process: send JSONL commands, wait for records. */
export class RpcSession {
	readonly records: RpcRecord[] = [];
	readonly #child: ChildProcessWithoutNullStreams;
	#buffer = "";
	#waiters: Array<() => void> = [];

	constructor(options: PiOptions = {}) {
		this.#child = spawn(PI_BIN, piArgs(options, ["--mode", "rpc"]), {
			cwd: options.cwd ?? ROOT,
			env: isolatedEnv(options.env),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk: string) => {
			this.#buffer += chunk;
			// Split on LF only: the protocol allows U+2028 inside JSON strings.
			for (let newline = this.#buffer.indexOf("\n"); newline >= 0; newline = this.#buffer.indexOf("\n")) {
				const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
				this.#buffer = this.#buffer.slice(newline + 1);
				if (line) this.records.push(JSON.parse(line) as RpcRecord);
			}
			for (const wake of this.#waiters.splice(0)) wake();
		});
	}

	send(command: Record<string, unknown>): void {
		this.#child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	/** Resolves with the first record matching `match`, including records already received. */
	waitFor(match: (record: RpcRecord) => boolean, timeoutMs = 30_000): Promise<RpcRecord> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`timed out waiting for an RPC record; saw ${this.records.map((r) => r.type).join(", ")}`)),
				timeoutMs,
			);
			const check = () => {
				const found = this.records.find(match);
				if (!found) return void this.#waiters.push(check);
				clearTimeout(timer);
				resolve(found);
			};
			check();
		});
	}

	async close(): Promise<void> {
		const closed = new Promise<void>((resolve) => this.#child.once("close", () => resolve()));
		this.#child.stdin.end();
		const kill = setTimeout(() => this.#child.kill("SIGKILL"), 5000);
		await closed;
		clearTimeout(kill);
	}
}
