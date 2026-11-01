// Random key sequences against the decorated editor. The Placeholder is one unit (ADR 0001): whatever keys come in, no
// edit may leave half of one, the cursor must stay inside the text, and nothing may throw. A failure prints its seed, and
// `FUZZ_SEED=<n> node --test test/integration/editor-fuzz.test.ts` replays that one run.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type Editor, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { decorateEditor, type EditorFactory } from "../../src/pi/editor.ts";

const PLACEHOLDER = "[ref:terse]";
const identity = (text: string) => text;
const THEME = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
const FAKE_TUI = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as Parameters<EditorFactory>[2];

/** The keys of the alphabet: letters and a space, so a bracket or a colon in the text can only come from a Placeholder. */
const TYPED = ["a", "b", "c", " "];
const KEYS = {
	backspace: "\x7f",
	delete: "\x1b[3~",
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x01",
	end: "\x05",
	ctrlW: "\x17",
	altBackspace: "\x1b\x7f",
	deleteToStart: "\x15",
	deleteToEnd: "\x0b",
	undo: "\x1f",
};

type Operation = { name: string; run: (editor: Editor) => void };
const OPERATIONS: Operation[] = [
	...TYPED.map((char) => ({ name: `type ${JSON.stringify(char)}`, run: (editor: Editor) => editor.handleInput(char) })),
	{ name: "insert Placeholder", run: (editor) => editor.insertTextAtCursor(PLACEHOLDER) },
	{ name: "insert Placeholder", run: (editor) => editor.insertTextAtCursor(PLACEHOLDER) },
	{ name: "paste Placeholder", run: (editor) => editor.handleInput(`\x1b[200~${PLACEHOLDER}\x1b[201~`) },
	...Object.entries(KEYS).map(([name, key]) => ({ name, run: (editor: Editor) => editor.handleInput(key) })),
];

/** mulberry32: a few lines of seeded randomness, so a failing run can be replayed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function decoratedEditor(): Editor {
	const editor = new CustomEditor(FAKE_TUI as unknown as ConstructorParameters<typeof CustomEditor>[0], THEME, keybindings);
	assert.equal(decorateEditor(editor), true);
	return editor;
}

/** Throws a message that names the seed and the keys so far when an invariant breaks. */
function checkInvariants(editor: Editor, seed: number, history: string[]): void {
	const where = `seed ${seed}, after: ${history.join(" > ")}`;
	const text = editor.getText();
	const rest = text.split(PLACEHOLDER).join("");
	assert.ok(!/[[\]:]/.test(rest), `half a Placeholder is left in ${JSON.stringify(text)} (${where})`);
	const lines = editor.getLines();
	const cursor = editor.getCursor();
	assert.ok(cursor.line >= 0 && cursor.line < lines.length, `cursor line ${cursor.line} is outside ${lines.length} line(s) (${where})`);
	assert.ok(
		cursor.col >= 0 && cursor.col <= (lines[cursor.line] ?? "").length,
		`cursor column ${cursor.col} is outside the line ${JSON.stringify(lines[cursor.line])} (${where})`,
	);
}

describe("random keys against the decorated editor", () => {
	const only = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : undefined;
	const seeds = only ?? Array.from({ length: 40 }, (_, index) => 1000 + index);
	for (const seed of seeds) {
		it(`keeps every Placeholder whole and the cursor in range (seed ${seed})`, async () => {
			const next = random(seed);
			const editor = decoratedEditor();
			const history: string[] = [];
			for (let step = 0; step < 80; step++) {
				const operation = OPERATIONS[Math.floor(next() * OPERATIONS.length)] as Operation;
				history.push(operation.name);
				operation.run(editor);
				checkInvariants(editor, seed, history.slice(-12));
			}
			// the editor's own asynchronous work (autocomplete, history) settles without throwing
			await new Promise((resolve) => setTimeout(resolve, 10));
			checkInvariants(editor, seed, ["settled"]);
		});
	}
});
