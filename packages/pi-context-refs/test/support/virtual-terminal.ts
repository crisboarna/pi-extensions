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

	/**
	 * Runs a slash command from the editor and resolves once `marker` is on screen. One Enter runs a command whose completion list is
	 * closed; with the list open the first Enter only closes it. So Enter is pressed again only while the command text is still in the
	 * editor, never into the dialog the command opened.
	 */
	async runCommand(command: string, marker: string, timeoutMs = 10_000): Promise<string> {
		const inEditor = (screen: string) => screen.split("\n").some((row) => row.trim() === command);
		this.type(command);
		await this.waitForScreen(inEditor, timeoutMs);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			this.press("\r");
			try {
				return await this.waitForScreen((screen) => screen.includes(marker), 600);
			} catch {
				const screen = await this.screen();
				if (!inEditor(screen)) return this.waitForScreen((current) => current.includes(marker), Math.max(1, deadline - Date.now()));
				if (Date.now() > deadline) throw new Error(`the command ${command} did not show ${JSON.stringify(marker)}; the screen shows:\n${screen}`);
			}
		}
	}

	/**
	 * Moves the selection of the pi selector that is open to the row holding `label`, then presses Enter. Rows are found by what is
	 * drawn (` → label` for the selected row, three spaces before the others), so a test never counts key presses. After each arrow
	 * key it waits for the screen to change, so it cannot press twice for one move.
	 */
	async chooseRow(label: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const rows = (await this.screen()).split("\n");
			const selected = rows.findLastIndex((row) => /^ → /.test(row));
			if (selected >= 0) {
				if (rows[selected]?.includes(label)) {
					this.press("\r");
					return;
				}
				const target = rows.findIndex(
					(row, index) => index !== selected && Math.abs(index - selected) <= 40 && /^ {3}\S/.test(row) && row.includes(label),
				);
				const before = rows.join("\n");
				this.press(target >= 0 && target < selected ? "\x1b[A" : "\x1b[B");
				await this.waitForScreen((screen) => screen !== before, 500).catch(() => undefined);
			}
			if (Date.now() > deadline) throw new Error(`could not select ${JSON.stringify(label)}; the screen shows:\n${rows.join("\n")}`);
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
	}

	/** Types `text` into the input dialog that is open and submits it with Enter. */
	answer(text: string): void {
		this.type(text);
		this.press("\r");
	}

	dispose(): void {
		this.#xterm.dispose();
	}
}
