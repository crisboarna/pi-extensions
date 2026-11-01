// A real pi-tui Editor with no terminal: feed it key bytes, read what it would draw.
// The autocomplete chain is built the way pi's interactive mode builds it.
import { type AutocompleteProvider, CombinedAutocompleteProvider, Editor, stripTerminalSequences } from "@earendil-works/pi-tui";

const identity = (text: string) => text;
const THEME = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

/** Stands in for the TUI the editor asks to repaint; the harness draws on demand. */
const FAKE_TUI = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

export type ProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

export class EditorHarness {
	readonly editor: Editor;
	/** Provider calls the editor has started and not seen finish; the editor settles when this is zero and the screen stops changing. */
	#inFlight = 0;

	/** `wrappers` are the factories extensions pass to `ctx.ui.addAutocompleteProvider`, in registration order. */
	constructor(wrappers: ProviderFactory[], basePath = process.cwd()) {
		// The editor takes the real TUI; the fake offers the two members the editor touches.
		this.editor = new Editor(FAKE_TUI as unknown as ConstructorParameters<typeof Editor>[0], THEME);
		let provider: AutocompleteProvider = new CombinedAutocompleteProvider([], basePath);
		const triggerCharacters: string[] = [];
		for (const wrap of wrappers) {
			provider = wrap(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) provider.triggerCharacters = [...new Set(triggerCharacters)];
		const asked = provider.getSuggestions.bind(provider);
		provider.getSuggestions = async (...args) => {
			this.#inFlight++;
			try {
				return await asked(...args);
			} finally {
				this.#inFlight--;
			}
		};
		this.editor.setAutocompleteProvider(provider);
	}

	/**
	 * Waits for the editor's asynchronous autocomplete: its debounce, then the provider's own work (file checks, git). A fixed wait
	 * was too short when many suites ran at once, so this waits until no provider call is in flight and the screen has not changed
	 * for two polls, however long that takes (the limit only turns a hang into a failure).
	 */
	async settle(timeoutMs = 10_000): Promise<void> {
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const deadline = Date.now() + timeoutMs;
		// the editor waits 20 ms before asking the provider, so a poll sooner than that could see an idle editor about to start
		await sleep(30);
		let last = this.screen;
		let stable = 0;
		while (stable < 2) {
			if (Date.now() > deadline) throw new Error(`the editor did not settle within ${timeoutMs} ms; it shows:\n${this.screen}`);
			await sleep(20);
			const now = this.screen;
			if (this.#inFlight === 0 && now === last) stable++;
			else stable = 0;
			last = now;
		}
	}

	/** Types `keys` one key at a time and lets the editor's asynchronous autocomplete settle. */
	async type(keys: string): Promise<void> {
		for (const key of keys) this.editor.handleInput(key);
		await this.settle();
	}

	/** Sends one raw key sequence, such as Enter (`"\r"`) or Tab (`"\t"`). */
	async press(sequence: string): Promise<void> {
		this.editor.handleInput(sequence);
		await this.settle();
	}

	get text(): string {
		return this.editor.getText();
	}

	get listOpen(): boolean {
		return this.editor.isShowingAutocomplete();
	}

	/** The editor as drawn, escape sequences removed. */
	get screen(): string {
		return this.editor.render(80).map(stripTerminalSequences).join("\n");
	}
}
