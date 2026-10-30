// Runs pi's interactive TUI in a pseudo-terminal and reads the screen it draws.
// The repository's pty runner gives pi a real terminal; xterm.js (already a dev
// dependency of the repository) plays the terminal, so a test asserts on the
// screen a user would see, not on escape sequences.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isolatedEnv, PI_BIN, type PiOptions, piArgs } from "./pi-process.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const RUN_IN_PTY = join(REPOSITORY_ROOT, "tools", "media", "run-in-pty.py");
const { Terminal } = createRequire(join(REPOSITORY_ROOT, "package.json"))("@xterm/xterm") as typeof import("@xterm/xterm");

const COLS = 100;
const ROWS = 40;

export class PtySession {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
	#raw = "";

	constructor(options: PiOptions = {}) {
		this.#child = spawn("python3", ["-I", RUN_IN_PTY, String(COLS), String(ROWS), "--", PI_BIN, ...piArgs(options, [])], {
			cwd: options.cwd,
			env: isolatedEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", ...options.env }),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.stdout.on("data", (chunk: Buffer) => {
			this.#raw += chunk.toString("utf8");
			this.#terminal.write(chunk);
		});
		// Terminal queries pi sends (device attributes, colours) are answered by the emulator.
		this.#terminal.onData((reply) => this.#child.stdin.write(reply));
	}

	/** Resolves when the TUI has finished starting and its editor takes keystrokes. */
	async ready(): Promise<void> {
		await this.waitForScreen((screen) => screen.includes("[Extensions]") && screen.includes("stub-model"));
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	/** Everything pi drew, scrollback included, one string per screen row, trailing blanks removed. */
	async screen(): Promise<string> {
		await new Promise<void>((resolve) => this.#terminal.write("", resolve));
		const buffer = this.#terminal.buffer.active;
		const rows: string[] = [];
		for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
		return rows.join("\n");
	}

	/** Every byte pi wrote to the terminal as text, escape sequences left in. Anything drawn at any moment is in here. */
	get raw(): string {
		return this.#raw;
	}

	/** Types `text` as keystrokes. `"\r"` is Enter, `"\x1b"` is Escape. */
	type(text: string): void {
		this.#child.stdin.write(text);
	}

	/** Resolves with the screen once `match` accepts it. */
	async waitForScreen(match: (screen: string) => boolean, timeoutMs = 30_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const screen = await this.screen();
			if (match(screen)) return screen;
			if (Date.now() > deadline) throw new Error(`timed out waiting for the screen; it shows:\n${screen}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async close(): Promise<void> {
		const closed = new Promise<void>((resolve) => this.#child.once("close", () => resolve()));
		this.#child.stdin.end();
		this.#child.kill("SIGTERM");
		const kill = setTimeout(() => this.#child.kill("SIGKILL"), 5000);
		await closed;
		clearTimeout(kill);
		this.#terminal.dispose();
	}
}
