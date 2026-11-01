// Random input against the navigator that `/tier watch` mounts through `ui.custom`. The rows hold a child's agent name,
// and a name is untrusted text, so one can hold wide characters, escape sequences or a very long run. Whatever it holds
// and whatever keys arrive, `handleInput` must not throw, no line may be wider than the terminal, and no terminal control
// sequence other than a style may reach a drawn line. `FUZZ_SEED=<n> node --test test/integration/navigator-fuzz.test.ts` replays one run.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fakeTheme } from "../support/fake-pi.ts";
import { boot } from "../support/harness.ts";

const WIDTHS = [20, 40, 80, 120, 200];
const ROWS = [10, 24, 40, 60, 100];
const KEYS = ["\x1b[A", "\x1b[B", "\r", "\x1b", "t", "q", " ", "\x1b[5~", "\x1b[6~", "\x1b[C", "\x00", "\x1b[200~p\x1b[201~", "x"];
const NAMES = [
	"scout",
	"個人のエージェント",
	"😀😀😀",
	"a".repeat(120),
	"tab\there",
	"\x1b[31mred\x1b[0m",
	"\x1b]0;title\x07",
	"\x1b[2Jclear",
	"new\nline",
	"\u202ebidi",
];

/** True for a C0 control character or DEL, other than a tab or a line feed. */
const isControl = (code: number): boolean => code < 0x09 || (code > 0x0a && code < 0x20) || code === 0x7f;
const hasControl = (text: string): boolean => [...text].some((char) => isControl(char.charCodeAt(0)));
/** Style sequences (`ESC [ ... m`) are the TUI's own, for example the resets truncation adds. */
const STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type View = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };

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

describe("random keys and names against the navigator", () => {
	const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: 20 }, (_, index) => 4000 + index);
	for (const seed of seeds) {
		it(`never throws, stays inside the terminal and draws no control sequence but a style (seed ${seed})`, async () => {
			const next = random(seed);
			const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
			const rows = pick(ROWS);
			const { session, agentDir, tier } = await boot({ subagents: {} });
			const live = join(agentDir, "pi-switchboard", "live");
			mkdirSync(live, { recursive: true });
			const now = Date.now();
			const parent = session.ctx.sessionManager.getSessionId();
			for (let child = 0; child < 1 + Math.floor(next() * 4); child++) {
				const status = {
					v: 1,
					session: `child-${child}`,
					parent,
					agent: pick(NAMES),
					status: pick(["running", "done", "failed"]),
					turn: child,
					tokens: { input: Math.floor(next() * 1e6), output: Math.floor(next() * 1e5), cacheRead: 0 },
					cost: next() * 3,
					startedAt: now,
					updatedAt: now,
				};
				writeFileSync(join(live, `child-${child}.json`), JSON.stringify(status));
			}
			let view: View | undefined;
			Object.assign(session.ctx, { hasUI: true });
			session.ctx.ui.custom = async (factory: (...args: unknown[]) => View) => {
				view = factory({ requestRender() {}, terminal: { rows } }, fakeTheme, {}, () => {});
			};
			await tier("watch");
			assert.ok(view, "the navigator was mounted");
			const history: string[] = [];
			try {
				for (let step = 0; step < 60; step++) {
					const key = pick(KEYS);
					history.push(JSON.stringify(key));
					view.handleInput(key);
					for (const width of WIDTHS) {
						for (const line of view.render(width)) {
							const unstyled = line.replace(STYLE, "");
							assert.ok(!hasControl(unstyled), `a control character reached the screen: ${JSON.stringify(line)} (seed ${seed})`);
							assert.ok(
								visibleWidth(line) <= width,
								`a line is ${visibleWidth(line)} cells wide at width ${width}: ${JSON.stringify(line)} (seed ${seed}, after ${history.slice(-8).join(" ")})`,
							);
						}
					}
				}
			} finally {
				view.dispose();
			}
		});
	}
});
