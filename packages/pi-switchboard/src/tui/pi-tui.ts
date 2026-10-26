import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { textOf } from "../classifier/evidence.ts";
import { type MirrorLine, readChildren, readMirror } from "../live/live.ts";

import type { Runtime } from "../runtime.ts";
import { buildRows, type NavModel, renderDecision, renderList, renderTranscript, type Style, widgetLine } from "./navigator.ts";

const WIDGET_KEY = "switchboard";

/** The navigator's data, rebuilt on every refresh. */
export function navModel(runtime: Runtime, ctx: ExtensionContext): NavModel {
	const now = Date.now();
	const sessionFile = ctx.sessionManager.getSessionFile();
	const parents = [sessionFile, ctx.sessionManager.getSessionId()].filter((p): p is string => Boolean(p));
	const children = readChildren(join(runtime.dir, "live"), parents);
	const decisions = runtime.engine.recent;
	const main = [...decisions].reverse().find((d) => d.scope === "main");
	const launches = runtime.launchDecisions;
	const totals = runtime.budgets.totals();
	const data = runtime.store.read();
	const cooldowns = Object.entries(data.members)
		.filter(([, h]) => (h.cooldownUntil ?? 0) > now)
		.map(([key, h]) => ({ member: key.replace(/^(member|model|provider):/u, ""), until: h.cooldownUntil ?? now, reason: h.cooldownReason ?? "error" }));
	const last = main ? runtime.config.profiles[main.profile.name] : undefined;
	return {
		rows: buildRows(
			{ ...(main ? { decision: main } : {}), running: !ctx.isIdle(), tokensIn: totals.session.tokens, tokensOut: 0, cost: totals.session.costUsd },
			children,
			launches,
		),
		...(main?.profile.name ? { profile: main.profile.name } : {}),
		cooldowns,
		budgetWarnings: runtime.budgets
			.exceeded(last?.budgets ?? runtime.config.budgets)
			.map((b) => `${b.scope} ${b.metric === "costUsd" ? "cost" : "tokens"} over budget`),
		...(runtime.autoContinueAt ? { autoContinueAt: runtime.autoContinueAt } : {}),
		now,
	};
}

function mainTranscript(ctx: ExtensionContext): MirrorLine[] {
	const out: MirrorLine[] = [];
	for (const entry of ctx.sessionManager.getBranch().slice(-80)) {
		const e = entry as { type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean }; timestamp?: string };
		if (e.type !== "message" || !e.message) continue;
		const ts = Date.parse(e.timestamp ?? "") || 0;
		const text = textOf(e.message.content as never);
		if (e.message.role === "user") out.push({ ts, kind: "task", text });
		else if (e.message.role === "assistant" && text) out.push({ ts, kind: "text", text });
		else if (e.message.role === "toolResult")
			out.push({ ts, kind: "tool-result", tool: e.message.toolName ?? "tool", isError: e.message.isError === true, text });
	}
	return out;
}

/**
 * Draws overlay rows inside a rounded border, each padded to the full width:
 * an overlay only covers the cells it writes, so a short row would let the
 * transcript behind it show through.
 */
export function framed(lines: string[], width: number, border: (text: string) => string): string[] {
	const inner = Math.max(1, width - 4);
	const edge = "─".repeat(Math.max(0, width - 2));
	return [border(`╭${edge}╮`), ...lines.map((line) => `${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`), border(`╰${edge}╯`)];
}

/** Opens the navigator overlay (DESIGN.md 11.5). */
export async function openNavigator(runtime: Runtime, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("The navigator needs the interactive TUI.", "warning");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) => {
			let selected = 0;
			let view: "list" | "decision" | "transcript" = "list";
			let scroll = 0;
			let model = navModel(runtime, ctx);
			const style: Style = (role, text) => (role === "bold" ? theme.bold(text) : theme.fg(role, text));
			const timer = setInterval(() => {
				model = navModel(runtime, ctx);
				tui.requestRender();
			}, runtime.config.ui.navigator.refreshMs);
			timer.unref?.();
			const close = () => {
				clearInterval(timer);
				done();
			};
			return {
				render(width: number): string[] {
					const row = model.rows[Math.min(selected, model.rows.length - 1)];
					const height = Math.max(10, (process.stdout.rows ?? 30) - 6);
					const lines =
						view === "list" || !row
							? renderList(model, selected, style)
							: view === "decision"
								? renderDecision(row, style)
								: renderTranscript(
										row,
										row.session ? readMirror(join(runtime.dir, "live"), row.session) : mainTranscript(ctx),
										scroll,
										height,
										style,
									);
					return framed(lines, width, (text) => theme.fg("border", text));
				},
				handleInput(data: string): void {
					if (matchesKey(data, "escape")) {
						if (view === "list") {
							close();
							return;
						}
						view = "list";
						scroll = 0;
					} else if (matchesKey(data, "up")) {
						if (view === "transcript") scroll++;
						else selected = Math.max(0, selected - 1);
					} else if (matchesKey(data, "down")) {
						if (view === "transcript") scroll = Math.max(0, scroll - 1);
						else selected = Math.min(model.rows.length - 1, selected + 1);
					} else if (matchesKey(data, "enter")) view = "decision";
					else if (data === "t") {
						view = "transcript";
						scroll = 0;
					} else if (data === "q") {
						close();
						return;
					} else return;
					tui.requestRender();
				},
				invalidate(): void {},
				dispose(): void {
					clearInterval(timer);
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
	);
}

/** Keeps the one-line widget above the editor in step with running children. */
export function startWidget(runtime: Runtime, ctx: ExtensionContext): () => void {
	if (runtime.config.ui.navigator.widget === "off" || !ctx.hasUI) return () => {};
	let shown = false;
	const tick = () => {
		try {
			const line = widgetLine(navModel(runtime, ctx));
			if (line) {
				ctx.ui.setWidget(WIDGET_KEY, [line]);
				shown = true;
			} else if (shown) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				shown = false;
			}
		} catch {
			// A stale context after a session switch; the next session starts its own widget.
		}
	};
	const timer = setInterval(tick, 2_000);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		if (shown) ctx.ui.setWidget(WIDGET_KEY, undefined);
	};
}
