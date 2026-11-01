// A pi-tui `Terminal` that draws into xterm.js instead of a real terminal, so real pi's interactive
// mode runs inside the test process: key bytes go in through `press`, and `screen` reads what a user
// would see. Modelled on pi-tui's own test helper (earendil-works/pi, packages/tui/test/virtual-terminal.ts),
// which is not published to npm.
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const { Terminal: XtermTerminal } = createRequire(join(REPOSITORY_ROOT, "package.json"))("@xterm/xterm") as typeof import("@xterm/xterm");

export class VirtualTerminal implements Terminal {
	readonly #xterm: InstanceType<typeof XtermTerminal>;
	#onInput: (data: string) => void = () => {};
	#onResize: () => void = () => {};
	#columns: number;
	#rows: number;
	#kitty: boolean;
	started = false;
	stopped = false;
	/** Every string pi wrote, escape sequences left in, for tests that check what was drawn at any moment. */
	raw = "";

	constructor({ columns = 100, rows = 40, kitty = true }: { columns?: number; rows?: number; kitty?: boolean } = {}) {
		this.#columns = columns;
		this.#rows = rows;
		this.#kitty = kitty;
		this.#xterm = new XtermTerminal({ cols: columns, rows, scrollback: 2000, allowProposedApi: true });
		// Terminal queries pi sends (device attributes, colours) are answered by the emulator, as in a real terminal.
		this.#xterm.onData((reply) => this.#onInput(reply));
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
		this.started = true;
	}

	stop(): void {
		this.stopped = true;
		this.#onInput = () => {};
		this.#onResize = () => {};
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.raw += data;
		this.#xterm.write(data);
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		return this.#kitty;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		else if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(): void {}

	setProgress(): void {}

	setProgramStatus(): void {}

	/** Types `keys` as one chunk of input, the way a terminal delivers it. `"\r"` is Enter, `"\x1b"` Escape, `"\x1b[B"` Down. */
	press(keys: string): void {
		this.#onInput(keys);
	}

	/** Types `text` one key at a time, as a person does; `press` delivers its argument as one chunk. */
	type(text: string): void {
		for (const key of text) this.#onInput(key);
	}

	resize(columns: number, rows: number = this.#rows): void {
		this.#columns = columns;
		this.#rows = rows;
		this.#xterm.resize(columns, rows);
		this.#onResize();
	}

	/** Everything drawn, scrollback included, one string per row, trailing blanks removed. */
	async screen(): Promise<string> {
		await new Promise<void>((resolve) => this.#xterm.write("", resolve));
		const buffer = this.#xterm.buffer.active;
		const rows: string[] = [];
		for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
		return rows.join("\n");
	}

	/** Resolves with the screen once `match` accepts it. */
	async waitForScreen(match: (screen: string) => boolean, timeoutMs = 10_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const screen = await this.screen();
			if (match(screen)) return screen;
			if (Date.now() > deadline) throw new Error(`timed out waiting for the screen; it shows:\n${screen}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	dispose(): void {
		this.#xterm.dispose();
	}
}
