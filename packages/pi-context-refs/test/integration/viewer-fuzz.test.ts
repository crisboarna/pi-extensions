// Random input against the read-only dialog of `/ref sent`, which `ui.custom` mounts. The text comes from a model and a
// tool, so it can hold anything: control characters, escape sequences, tabs, wide characters and very long lines. Whatever
// it holds and whatever keys arrive, `handleInput` must not throw, no line may be wider than the terminal, and no
// terminal control sequence other than a style may reach a drawn line. `FUZZ_SEED=<n> node --test test/integration/viewer-fuzz.test.ts` replays one run.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showReadOnlyText } from "../../src/pi/text-viewer.ts";

const WIDTHS = [10, 24, 40, 80, 200];
const ROWS = [3, 8, 24, 60];
const KEYS = ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F", "\x1b[1~", "\x1b[4~", " ", "x", "\x00", "\x1b[200~p\x1b[201~", "\x1b[99;5u"];
const PIECES = [
	"plain words ",
	"個人のゾーン ",
	"😀😀😀 ",
	"\t",
	"\x1b[31mred\x1b[0m ",
	"\x1b]0;title\x07",
	"\x1b[2J",
	"\x07",
	"\x00",
	"\r",
	"\n",
	"\n\n",
	"x".repeat(150),
	"\u0301",
	"\u200b",
	"\u202e",
];

/** True for a C0 control character or DEL, other than a tab or a line feed. */
const isControl = (code: number): boolean => code < 0x09 || (code > 0x0a && code < 0x20) || code === 0x7f;
const hasControl = (text: string): boolean => [...text].some((char) => isControl(char.charCodeAt(0)));
/** Style sequences (`ESC [ ... m`) are the TUI's own, for example the resets truncation adds. */
const STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Component = { render(width: number): string[]; handleInput(data: string): void };

function mount(text: string, rows: number): Component {
	let component: Component | undefined;
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const ctx = {
		ui: {
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows } }, theme, {}, resolve);
				}),
		},
	} as unknown as ExtensionContext;
	void showReadOnlyText(ctx, "Last message sent, as the model received it", text);
	assert.ok(component, "the dialog was mounted");
	return component;
}

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

describe("random text and keys against the /ref sent dialog", () => {
	const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: 30 }, (_, index) => 3000 + index);
	for (const seed of seeds) {
		it(`never throws, stays inside the terminal and draws no control character (seed ${seed})`, () => {
			const next = random(seed);
			const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
			const text = Array.from({ length: Math.floor(next() * 200) }, () => pick(PIECES)).join("");
			const component = mount(text, pick(ROWS));
			const history: string[] = [];
			for (let step = 0; step < 60; step++) {
				const key = pick(KEYS);
				history.push(JSON.stringify(key));
				component.handleInput(key);
				for (const width of WIDTHS) {
					const lines = component.render(width);
					for (const line of lines) {
						// style sequences (`ESC [ ... m`) are the TUI's own, for example the resets truncation adds; anything else is from the text
						const unstyled = line.replace(STYLE, "");
						assert.ok(!hasControl(unstyled), `a control character reached the screen: ${JSON.stringify(line)} (seed ${seed})`);
						assert.ok(
							visibleWidth(line) <= width,
							`a line is ${visibleWidth(line)} cells wide at width ${width}: ${JSON.stringify(line)} (seed ${seed}, after ${history.slice(-8).join(" ")})`,
						);
					}
				}
			}
		});
	}
});
