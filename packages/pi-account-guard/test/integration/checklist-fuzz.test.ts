// Random input against the tag checklist that `ui.custom` mounts. Whatever bytes arrive, `handleInput` must not throw and
// every line `render` returns must fit the width it was asked for, wide characters counted by their cells. A failure prints
// its seed, and `FUZZ_SEED=<n> node --test test/integration/checklist-fuzz.test.ts` replays that one run.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { askZonesWithChecklist } from "../../src/pi/tag-checklist.ts";

const ZONES = ["work", "個人 personal", "😀 an emoji zone with a very long name that has to wrap across several lines of a narrow terminal"];
const WIDTHS = [10, 24, 40, 80, 200];
const MANY = Array.from({ length: 40 }, (_, index) => `zone${String(index + 1).padStart(2, "0")}`);
const HEIGHTS = [10, 24, 50];
const HINT = "up/down move, space checks, enter confirms, esc cancels";
const NOTHING_CHECKED = "Check at least one zone, or press esc to cancel.";
const NAMED_KEYS = ["\x1b[A", "\x1b[B", " ", "\r", "\x1b", "\t", "\x7f", "\x1b[C", "\x1b[D", "\x1b[200~paste\x1b[201~", "\x03", "\x00"];
const PRINTABLE = ["a", "Z", "7", "é", "個", "😀", "\u200b", "\u0301", " "];

type Component = { render(width: number): string[]; handleInput(data: string): void };

function mount(rows = 24, zones: string[] = ZONES): Component {
	let component: Component | undefined;
	const ctx = {
		ui: {
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows } }, {}, {}, resolve);
				}),
		},
	} as unknown as ExtensionContext;
	void askZonesWithChecklist(ctx, "Which zones does this account belong to?", zones);
	assert.ok(component, "the checklist was mounted");
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

function randomInput(next: () => number): string {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const roll = next();
	if (roll < 0.5) return pick(NAMED_KEYS);
	if (roll < 0.75) return pick(PRINTABLE);
	if (roll < 0.9) return `\x1b[${Math.floor(next() * 300)}${pick(["~", "u", "A", "m", ";2u", ";5~"])}`;
	return Array.from({ length: 1 + Math.floor(next() * 12) }, () => String.fromCharCode(Math.floor(next() * 256))).join("");
}

describe("random input against the tag checklist", () => {
	const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: 30 }, (_, index) => 2000 + index);
	for (const seed of seeds) {
		it(`never throws and never draws a line wider than the terminal (seed ${seed})`, () => {
			const next = random(seed);
			const component = mount();
			const history: string[] = [];
			for (let step = 0; step < 100; step++) {
				const input = randomInput(next);
				history.push(JSON.stringify(input));
				component.handleInput(input);
				for (const width of WIDTHS) {
					for (const line of component.render(width)) {
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

describe("random input against a long tag checklist on terminals of several heights", () => {
	const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: 10 }, (_, index) => 3000 + index);
	for (const rows of HEIGHTS) {
		for (const seed of seeds) {
			it(`keeps the cursor row and the hint in the output at ${rows} rows (seed ${seed})`, () => {
				const next = random(seed);
				const component = mount(rows, MANY);
				const history: string[] = [];
				for (let step = 0; step < 100; step++) {
					const input = randomInput(next);
					history.push(JSON.stringify(input));
					component.handleInput(input);
					const lines = component.render(80);
					const context = `(${rows} rows, seed ${seed}, after ${history.slice(-8).join(" ")})`;
					assert.ok(
						lines.some((line) => line.startsWith("> [")),
						`the cursor row is missing ${context}`,
					);
					const last = lines.at(-1);
					assert.ok(last === HINT || last === NOTHING_CHECKED, `the last line is not the hint: ${JSON.stringify(last)} ${context}`);
					assert.ok(lines.length <= Math.max(8, rows - 8) + 1, `${lines.length} lines are too many for ${rows} rows ${context}`);
				}
			});
		}
	}
});
