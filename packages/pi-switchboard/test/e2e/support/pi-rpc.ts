// Drives the repository's pinned pi in RPC mode on an agent folder, so
// pi-switchboard loads from what installTarball put there. A command such as
// `/tier doctor` is done when pi answers its prompt with
// `disposition: "handled"`: pi awaits an extension command's handler before
// answering, so every notice the command shows has arrived by then. A prompt
// to a model is done when pi sends `agent_settled`, after any retries.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { REPO } from "./run.ts";

const PI_CLI = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

export interface Notice {
	level: string;
	message: string;
}

export type RpcRecord = { type: string; id?: string; [key: string]: unknown };

/** An assistant message of a turn: which model answered, and what. */
export interface Reply {
	provider: string;
	model: string;
	text: string;
	stopReason: string;
	errorMessage?: string;
}

/** What one prompt to a model produced, up to `agent_settled`. */
export interface Turn {
	replies: Reply[];
	/** Every record of the turn, such as tool executions. */
	records: RpcRecord[];
	/** The notices shown during the turn, joined. */
	notices: string;
}

/** The assistant messages among `records`. */
export function repliesOf(records: readonly RpcRecord[]): Reply[] {
	return records.flatMap((record) => {
		const message = record.message as Record<string, unknown> | undefined;
		if (record.type !== "message_end" || message?.role !== "assistant") return [];
		const content = (message.content as Array<{ type: string; text?: string }> | undefined) ?? [];
		return [
			{
				provider: String(message.provider),
				model: String(message.model),
				text: content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(""),
				stopReason: String(message.stopReason),
				...(message.errorMessage ? { errorMessage: String(message.errorMessage) } : {}),
			},
		];
	});
}

export interface PiOptions {
	env: Record<string, string>;
	cwd: string;
	/** Log file prefix: `<log>.jsonl` gets every record, `<log>.stderr` pi's diagnostics. */
	log: string;
	/** pi's `--offline` (no catalog refreshes or other automatic network calls); default true. */
	offline?: boolean;
	/** More command-line arguments, such as `--session-dir`. */
	args?: string[];
}

export class PiSession {
	/** Every notice so far, in order. */
	readonly notices: Notice[] = [];
	/** `extension_error` records: an extension handler threw. */
	readonly errors: string[] = [];
	/** pi's stderr. */
	stderr = "";
	/** The commands pi listed at start, such as `tier` and `guard`. */
	commands: string[] = [];
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #log: WriteStream;
	readonly #records: RpcRecord[] = [];
	#waiters: Array<() => void> = [];
	#buffer = "";
	#exited = false;
	#next = 0;

	private constructor(options: PiOptions) {
		const args = [
			PI_CLI,
			"--mode",
			"rpc",
			...(options.args?.includes("--session-dir") ? [] : ["--no-session"]),
			...(options.offline === false ? [] : ["--offline"]),
			...(options.args ?? []),
		];
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
		const ready = await session.#response("ready", 120_000);
		session.commands = ((ready.data as { commands?: Array<{ name: string }> } | undefined)?.commands ?? []).map((command) => command.name);
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

	/** Selects `provider/modelId`, such as the virtual model `switchboard/auto`. */
	async setModel(provider: string, modelId: string): Promise<void> {
		const id = `s${this.#next++}`;
		this.#send({ id, type: "set_model", provider, modelId });
		const response = await this.#response(id, 30_000);
		if (response.success !== true) throw new Error(`pi did not select ${provider}/${modelId}: ${JSON.stringify(response).slice(0, 400)}`);
	}

	/** How many records have arrived; pass it to `waitForRecord` to wait only for later ones. */
	mark(): number {
		return this.#records.length;
	}

	/** Every record from `from` on. */
	recordsSince(from: number): RpcRecord[] {
		return this.#records.slice(from);
	}

	/** Waits for a record from `from` on that matches, such as a later `agent_settled`, and returns its index. */
	waitForRecord(match: (record: RpcRecord) => boolean, timeoutMs: number, from = 0, what = "a matching record"): Promise<number> {
		return this.#until(
			() => {
				const index = this.#records.findIndex((record, at) => at >= from && match(record));
				return index >= 0 ? index : undefined;
			},
			timeoutMs,
			what,
		);
	}

	/** Sends `text` as a prompt and returns pi's answer to it, without waiting for a turn: an extension may stop one starting. */
	async submit(text: string, timeoutMs = 60_000): Promise<RpcRecord> {
		const id = `p${this.#next++}`;
		this.#send({ id, type: "prompt", message: text });
		const response = await this.#response(id, timeoutMs);
		if (response.success !== true) throw new Error(`pi refused the prompt: ${JSON.stringify(response).slice(0, 400)}`);
		return response;
	}

	/** Sends `text` as a prompt to the selected model and waits until pi settles, retries included. */
	async prompt(text: string, timeoutMs = 60_000): Promise<Turn> {
		const from = this.#records.length;
		const noticesFrom = this.notices.length;
		await this.submit(text, timeoutMs);
		const settled = await this.waitForRecord((record) => record.type === "agent_settled", timeoutMs, from, `pi to settle after "${text}"`);
		const records = this.#records.slice(from, settled + 1);
		return {
			replies: repliesOf(records),
			records,
			notices: this.notices
				.slice(noticesFrom)
				.map((notice) => notice.message)
				.join("\n"),
		};
	}

	/**
	 * Waits until pi lists `model` (`provider/id`) among its available models. A
	 * provider such as llama.cpp lists a server's models a moment after start.
	 */
	async waitForModel(model: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const id = `m${this.#next++}`;
			this.#send({ id, type: "get_available_models" });
			const data = (await this.#response(id, 30_000)).data as { models?: Array<{ provider: string; id: string }> } | undefined;
			if (data?.models?.some((listed) => `${listed.provider}/${listed.id}` === model)) return;
			if (Date.now() > deadline) throw new Error(`pi did not list ${model} within ${Math.round(timeoutMs / 1000)} s`);
			await new Promise((done) => setTimeout(done, 500));
		}
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

	async #response(id: string, timeoutMs: number): Promise<RpcRecord> {
		const at = await this.waitForRecord((record) => record.type === "response" && record.id === id, timeoutMs, 0, `a response to ${id}`);
		return this.#records[at] as RpcRecord;
	}

	/** Resolves with what `found` returns once it is defined; fails if pi exits first or after `timeoutMs`. */
	#until<T>(found: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`pi gave no ${what} in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
			const check = () => {
				const value = found();
				if (value !== undefined) {
					clearTimeout(timer);
					resolve(value);
				} else if (this.#exited) {
					clearTimeout(timer);
					reject(new Error(`pi exited before ${what}:\n${this.stderr.slice(-2000)}`));
				} else this.#waiters.push(check);
			};
			check();
		});
	}
}
