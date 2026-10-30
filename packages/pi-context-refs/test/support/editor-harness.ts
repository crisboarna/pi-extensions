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
		this.editor.setAutocompleteProvider(provider);
	}

	/** Types `keys` one key at a time and lets the editor's asynchronous autocomplete settle. */
	async type(keys: string): Promise<void> {
		for (const key of keys) this.editor.handleInput(key);
		await new Promise((resolve) => setTimeout(resolve, 80));
	}

	/** Sends one raw key sequence, such as Enter (`"\r"`) or Tab (`"\t"`). */
	async press(sequence: string): Promise<void> {
		this.editor.handleInput(sequence);
		await new Promise((resolve) => setTimeout(resolve, 80));
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
