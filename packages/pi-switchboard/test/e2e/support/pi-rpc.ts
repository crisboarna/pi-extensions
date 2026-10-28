// Drives the repository's pinned pi in RPC mode on an agent folder, so
// pi-switchboard loads from what installTarball put there. A command such as
// `/tier doctor` is done when pi answers its prompt with
// `disposition: "handled"`: pi awaits an extension command's handler before
// answering, so every notice the command shows has arrived by then.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { REPO } from "./run.ts";

const PI_CLI = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

export interface Notice {
	level: string;
	message: string;
}

type RpcRecord = { type: string; id?: string; [key: string]: unknown };

export interface PiOptions {
	env: Record<string, string>;
	cwd: string;
	/** Log file prefix: `<log>.jsonl` gets every record, `<log>.stderr` pi's diagnostics. */
	log: string;
	/** pi's `--offline` (no catalog refreshes or other automatic network calls); default true. */
	offline?: boolean;
}

export class PiSession {
	/** Every notice so far, in order. */
	readonly notices: Notice[] = [];
	/** `extension_error` records: an extension handler threw. */
	readonly errors: string[] = [];
	/** pi's stderr. */
	stderr = "";
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #log: WriteStream;
	readonly #records: RpcRecord[] = [];
	#waiters: Array<() => void> = [];
	#buffer = "";
	#exited = false;
	#next = 0;

	private constructor(options: PiOptions) {
		const args = [PI_CLI, "--mode", "rpc", "--no-session", ...(options.offline === false ? [] : ["--offline"])];
		this.#child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
		this.#log = createWriteStream(`${options.log}.jsonl`);
		const stderrLog = createWriteStream(`${options.log}.stderr`);
		this.#child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			this.stderr += chunk;
			stderrLog.write(chunk);
		});
		this.#child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.#read(chunk));
		this.#child.on("close", () => {
			this.#exited = true;
			stderrLog.end();
			this.#wake();
		});
	}

	/** Starts pi and waits until it answers over RPC, which it does once the extensions have loaded. */
	static async start(options: PiOptions): Promise<PiSession> {
		const session = new PiSession(options);
		session.#send({ id: "ready", type: "get_commands" });
		await session.#response("ready", 120_000);
		return session;
	}

	/** Runs `text` as a prompt and returns the notices it showed, joined; fails unless an extension command handled it. */
	async command(text: string, timeoutMs = 600_000): Promise<string> {
		const id = `c${this.#next++}`;
		const from = this.notices.length;
		this.#send({ id, type: "prompt", message: text });
		const response = await this.#response(id, timeoutMs);
		const data = response.data as { disposition?: string } | undefined;
		if (response.success !== true || data?.disposition !== "handled")
			throw new Error(`pi did not handle ${text} as a command: ${JSON.stringify(response).slice(0, 400)}`);
		return this.notices
			.slice(from)
			.map((notice) => notice.message)
			.join("\n");
	}

	/** Closes stdin, which asks pi to shut down, then kills it after 10 s. */
	async close(): Promise<void> {
		if (!this.#exited) {
			this.#child.stdin.end();
			const kill = setTimeout(() => this.#child.kill("SIGKILL"), 10_000);
			await new Promise<void>((done) => (this.#exited ? done() : this.#child.once("close", () => done())));
			clearTimeout(kill);
		}
		this.#log.end();
	}

	#send(command: Record<string, unknown>): void {
		this.#child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	#read(chunk: string): void {
		this.#buffer += chunk;
		// Split on LF only: the protocol allows U+2028 inside JSON strings.
		for (let newline = this.#buffer.indexOf("\n"); newline >= 0; newline = this.#buffer.indexOf("\n")) {
			const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			this.#log.write(`${line}\n`);
			this.#handle(JSON.parse(line) as RpcRecord);
		}
		this.#wake();
	}

	#handle(record: RpcRecord): void {
		this.#records.push(record);
		if (record.type === "extension_error") this.errors.push(`${String(record.event)}: ${String(record.error)}`);
		if (record.type !== "extension_ui_request") return;
		if (record.method === "notify") this.notices.push({ level: String(record.notifyType ?? "info"), message: String(record.message) });
		// Setup and eval ask before doing anything that cannot be undone; the suites always agree. Other dialogs are cancelled.
		else if (record.method === "confirm") this.#send({ type: "extension_ui_response", id: record.id, confirmed: true });
		else if (["select", "input", "editor"].includes(String(record.method))) this.#send({ type: "extension_ui_response", id: record.id, cancelled: true });
	}

	#wake(): void {
		for (const wake of this.#waiters.splice(0)) wake();
	}

	#response(id: string, timeoutMs: number): Promise<RpcRecord> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`pi gave no response to ${id} in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
			const check = () => {
				const found = this.#records.find((record) => record.type === "response" && record.id === id);
				if (found) {
					clearTimeout(timer);
					resolve(found);
				} else if (this.#exited) {
					clearTimeout(timer);
					reject(new Error(`pi exited before answering ${id}:\n${this.stderr.slice(-2000)}`));
				} else this.#waiters.push(check);
			};
			check();
		});
	}
}
