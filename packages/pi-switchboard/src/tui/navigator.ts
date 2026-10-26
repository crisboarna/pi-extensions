import type { LiveStatus, MirrorLine } from "../live/live.ts";
import { explain } from "../record/describe.ts";
import type { DecisionEntry } from "../record/types.ts";

/** One row of the navigator: the main task or one subagent child. */
export interface NavRow {
	key: string;
	label: string;
	status: "running" | "done" | "error" | "idle";
	tier?: string;
	model?: string;
	turn?: number;
	tool?: string;
	tokensIn: number;
	tokensOut: number;
	tokensPerSecond?: number;
	cost: number;
	depth: number;
	decision?: DecisionEntry;
	/** Child session id, for its transcript mirror. */
	session?: string;
}

export interface NavModel {
	rows: NavRow[];
	profile?: string;
	cooldowns: Array<{ member: string; until: number; reason: string }>;
	budgetWarnings: string[];
	autoContinueAt?: number;
	now: number;
}

export type Style = (role: "accent" | "dim" | "warning" | "success" | "error" | "bold", text: string) => string;

const plain: Style = (_role, text) => text;

function compact(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function money(n: number): string {
	return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Builds rows from the main session's latest decision and the children's live status files. */
export function buildRows(main: { decision?: DecisionEntry; running: boolean; tokensIn: number; tokensOut: number; cost: number }, children: readonly LiveStatus[], launches: readonly DecisionEntry[]): NavRow[] {
	const rows: NavRow[] = [];
	const d = main.decision;
	rows.push({
		key: "main",
		label: d ? `task ${d.task}` : "main",
		status: main.running ? "running" : "idle",
		...(d?.tier.chosen ? { tier: d.tier.chosen } : {}),
		...(d ? { model: `${d.model.provider}/${d.model.id}` } : {}),
		tokensIn: main.tokensIn,
		tokensOut: main.tokensOut,
		cost: main.cost,
		depth: 0,
		...(d ? { decision: d } : {}),
	});
	for (const child of children) {
		const decision =
			(child.launchDecisionId ? launches.find((l) => l.id === child.launchDecisionId) : undefined) ??
			[...launches].reverse().find((l) => l.subagent?.agent === child.agent && Date.parse(l.ts) <= child.startedAt + 5_000);
		rows.push({
			key: child.session,
			label: child.agent ?? "subagent",
			status: child.status,
			...(child.tier ?? decision?.tier.chosen ? { tier: child.tier ?? decision?.tier.chosen } : {}),
			...(child.model ? { model: child.model } : {}),
			turn: child.turn,
			...(child.currentTool ? { tool: child.currentTool } : {}),
			tokensIn: child.tokens.input + child.tokens.cacheRead,
			tokensOut: child.tokens.output,
			...(child.tokensPerSecond ? { tokensPerSecond: child.tokensPerSecond } : {}),
			cost: child.cost,
			depth: 1,
			...(decision ? { decision } : {}),
			session: child.session,
		});
	}
	return rows;
}

/** Header, rows and footer of the list view, as plain lines (callers truncate to width). */
export function renderList(model: NavModel, selected: number, style: Style = plain): string[] {
	const running = model.rows.filter((r) => r.status === "running").length;
	const perTier = new Map<string, number>();
	for (const row of model.rows) if (row.status === "running" && row.tier) perTier.set(row.tier, (perTier.get(row.tier) ?? 0) + 1);
	const cost = model.rows.reduce((sum, r) => sum + r.cost, 0);
	const header = [
		"⇄ switchboard",
		model.profile,
		`${running} running`,
		...[...perTier.entries()].map(([tier, n]) => `${tier} ${n}`),
		money(cost),
		model.budgetWarnings.length ? style("warning", "over budget") : "budget ok",
	].filter(Boolean);
	const lines = [style("accent", header.join(" · ")), ""];
	model.rows.forEach((row, index) => {
		const icon = row.status === "running" ? "●" : row.status === "error" ? style("error", "✗") : row.status === "done" ? style("success", "✓") : "○";
		const branch = row.depth === 0 ? "" : index === model.rows.length - 1 ? "└ " : "├ ";
		const cells = [
			`${branch}${icon} ${row.label}`.padEnd(18),
			(row.tier ?? "—").padEnd(10),
			(row.model ?? "").padEnd(32),
			row.turn !== undefined ? `turn ${row.turn}`.padEnd(8) : "".padEnd(8),
			(row.tool ?? "").padEnd(10),
			`${compact(row.tokensIn)}/${compact(row.tokensOut)}`.padEnd(12),
			row.tokensPerSecond ? `${row.tokensPerSecond} t/s`.padEnd(9) : "".padEnd(9),
			money(row.cost),
		];
		const line = cells.join(" ");
		lines.push(index === selected ? style("bold", `› ${line}`) : `  ${line}`);
	});
	lines.push("");
	for (const cool of model.cooldowns.slice(0, 4)) lines.push(style("warning", `cooldown: ${cool.member} until ${clock(cool.until)} (${cool.reason})`));
	for (const warning of model.budgetWarnings) lines.push(style("warning", warning));
	if (model.autoContinueAt) lines.push(style("dim", `auto-continue in ${Math.max(0, Math.round((model.autoContinueAt - model.now) / 60_000))} min (/tier resume cancel)`));
	lines.push(style("dim", "↑↓ move · enter decision · t transcript · esc close"));
	return lines;
}

export function renderDecision(row: NavRow, style: Style = plain): string[] {
	const lines = [style("accent", `${row.label} · decision`), ""];
	lines.push(...(row.decision ? explain(row.decision) : ["No routing decision recorded for this row."]));
	lines.push("", style("dim", "t transcript · esc back"));
	return lines;
}

export function renderTranscript(row: NavRow, mirror: readonly MirrorLine[], scroll: number, height: number, style: Style = plain): string[] {
	const body: string[] = [];
	for (const line of mirror) {
		const tag = line.kind === "tool-call" ? `→ ${line.tool}` : line.kind === "tool-result" ? `${line.isError ? "✗" : "←"} ${line.tool}` : line.kind === "task" ? "task" : line.kind === "error" ? "error" : "reply";
		const text = line.text.replace(/\s+/gu, " ").slice(0, 400);
		body.push(`${style(line.kind === "error" || line.isError ? "warning" : "dim", tag.padEnd(14))} ${text}`);
	}
	const visible = Math.max(1, height - 3);
	const start = Math.max(0, Math.min(body.length - visible, body.length - visible - scroll));
	return [style("accent", `${row.label} · transcript (${mirror.length} entries)`), ...body.slice(start, start + visible), style("dim", "↑↓ scroll · esc back")];
}

/** The one-line widget shown above the editor while children run. */
export function widgetLine(model: NavModel): string | undefined {
	const running = model.rows.filter((r) => r.depth > 0 && r.status === "running");
	if (running.length === 0 && !model.autoContinueAt) return undefined;
	const perTier = new Map<string, number>();
	for (const row of running) if (row.tier) perTier.set(row.tier, (perTier.get(row.tier) ?? 0) + 1);
	const cost = model.rows.reduce((sum, r) => sum + r.cost, 0);
	const parts = [`⇄ ${running.length} running`, ...[...perTier.entries()].map(([tier, n]) => `${tier} ${n}`), money(cost)];
	if (model.autoContinueAt) parts.push(`continue in ${Math.max(0, Math.round((model.autoContinueAt - model.now) / 60_000))} min`);
	return parts.join(" · ");
}
