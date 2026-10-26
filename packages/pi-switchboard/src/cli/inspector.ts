import type { MirrorLine } from "../live/live.ts";
import { explain, summarize } from "../record/describe.ts";
import type { DecisionEntry, ProfileSnapshotEntry } from "../record/types.ts";
import { aggregate, type Task, type Timeline } from "../timeline/parse.ts";

const esc = (value: unknown): string =>
	String(value ?? "").replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const money = (value: number): string => (value === 0 ? "$0" : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);
const tokens = (value: number): string =>
	value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

interface Price {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Cost of a task's tokens at a member's catalog price (per million tokens), ignoring cache effects. */
function priced(task: Task, price: Price | undefined): number | undefined {
	if (!price) return undefined;
	let total = 0;
	for (const r of task.requests) total += ((r.input + r.cacheRead + r.cacheWrite) * price.input + r.output * price.output) / 1_000_000;
	return total;
}

function tierPrice(snapshot: ProfileSnapshotEntry | undefined, tier: string): Price | undefined {
	return snapshot?.tiers.find((t) => t.name === tier)?.members.find((m) => m.price)?.price;
}

function decisionBlock(decision: DecisionEntry): string {
	const warn = decision.kind === "fallback" || decision.kind === "inactive" || decision.error;
	return `<details class="decision${warn ? " warn" : ""}"><summary>${esc(summarize(decision))}</summary><pre>${esc(explain(decision).join("\n"))}</pre></details>`;
}

function mirrorBlock(lines: readonly MirrorLine[]): string {
	const rows = lines
		.map((line) => {
			const tag =
				line.kind === "tool-call" ? `→ ${line.tool ?? ""}` : line.kind === "tool-result" ? `${line.isError ? "✗" : "←"} ${line.tool ?? ""}` : line.kind;
			return `<div class="${line.isError || line.kind === "error" ? "err" : ""}"><span class="dim">${esc(tag.padEnd(14))}</span> ${esc(line.text.replace(/\s+/gu, " ").slice(0, 600))}</div>`;
		})
		.join("");
	return `<details class="decision"><summary>transcript mirror (${lines.length} entries, redacted and bounded)</summary><pre>${rows}</pre></details>`;
}

function taskBlock(task: Task, snapshot: ProfileSnapshotEntry | undefined, depth: number): string {
	const main = task.decisions.find((d) => d.reason === "user") ?? task.decisions[0];
	const tier = main?.tier.chosen ?? "";
	const member = main ? `${main.model.provider}/${main.model.id}` : "";
	const switches = task.requests.filter((r) => r.switched).length;
	const fallback = task.decisions.some((d) => d.kind === "fallback");
	const top = snapshot ? priced(task, tierPrice(snapshot, snapshot.topTier)) : undefined;
	const base = snapshot ? priced(task, tierPrice(snapshot, snapshot.baselineTier)) : undefined;
	const requests = task.requests
		.map(
			(r) =>
				`<tr${r.switched ? ' class="switch"' : ""}${r.error ? ' class="err"' : ""}><td>${esc(r.ts.slice(11, 19))}</td><td>${esc(`${r.provider}/${r.model}`)}${r.thinking ? `:${esc(r.thinking)}` : ""}${r.switched ? ' <span class="tag">switch</span>' : ""}</td><td class="n">${tokens(r.input)}</td><td class="n">${tokens(r.cacheRead)}</td><td class="n">${tokens(r.output)}</td><td class="n">${money(r.cost)}</td><td class="n">${r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : ""}</td><td>${esc(r.error ?? r.stopReason ?? "")}</td></tr>`,
		)
		.join("");
	const tools = task.tools
		.map(
			(t) =>
				`<li class="${t.isError ? "err" : ""}"><code>${esc(t.name)}</code> ${t.isError ? "✗" : "✓"} <span class="dim">${esc(t.preview.replace(/\s+/gu, " ").slice(0, 160))}</span></li>`,
		)
		.join("");
	const children = task.children
		.map((child) => {
			const transcript = child.timeline?.mirror ? mirrorBlock(child.timeline.mirror) : "";
			const nested = child.timeline
				? child.timeline.tasks.map((t) => taskBlock(t, snapshot, depth + 1)).join("") + transcript
				: '<p class="dim">Child session not available (in-memory child, removed file, or its transcript mirror was already swept).</p>';
			return `<div class="child">${decisionBlock(child.decision)}${child.runId ? `<p class="dim">run ${esc(child.runId)}</p>` : ""}${nested}</div>`;
		})
		.join("");
	return `<details class="task" data-tier="${esc(tier)}" data-member="${esc(member)}" data-fallback="${fallback}" data-switch="${switches > 0}"${depth === 0 ? "" : " open"}>
<summary><span class="idx">#${task.index}</span><span class="req">${esc(task.request.replace(/\s+/gu, " ").slice(0, 140) || "(no request text)")}</span><span class="pill">${esc(tier || "—")}</span><span class="dim">${esc(member)}</span><span class="n">${money(task.cost)}</span>${switches ? `<span class="tag">${switches} switch${switches > 1 ? "es" : ""}</span>` : ""}${fallback ? '<span class="tag warn">fallback</span>' : ""}</summary>
<div class="body">
${task.decisions.map(decisionBlock).join("")}
${top !== undefined || base !== undefined ? `<p class="dim">Counterfactual (estimate, ignores cache): top tier ${top !== undefined ? money(top) : "n/a"} · baseline ${base !== undefined ? money(base) : "n/a"}</p>` : ""}
${requests ? `<table><thead><tr><th>time</th><th>model</th><th>in</th><th>cache</th><th>out</th><th>cost</th><th>dur</th><th>stop</th></tr></thead><tbody>${requests}</tbody></table>` : ""}
${tools ? `<ul class="tools">${tools}</ul>` : ""}
${children}
</div></details>`;
}

function rows(map: Map<string, { cost: number; tokens: number; requests: number }>): string {
	return [...map.entries()]
		.sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
		.map(
			([key, v]) =>
				`<tr><td>${esc(key)}</td><td class="n">${money(v.cost)}</td><td class="n">${tokens(v.tokens)}</td><td class="n">${v.requests}</td></tr>`,
		)
		.join("");
}

/** A self-contained, offline HTML page for one session and its subagent sessions (DESIGN.md 11.4). */
export function renderInspector(timeline: Timeline, title = "Switchboard inspector"): string {
	const snapshot = timeline.profiles.at(-1);
	const byTier = aggregate(timeline, (_r, d) => d?.tier.chosen || "unrouted");
	const byMember = aggregate(timeline, (r) => `${r.provider}/${r.model}`);
	const byProvider = aggregate(timeline, (r) => r.provider);
	const decisions = timeline.tasks.flatMap((t) => [...t.decisions, ...t.children.map((c) => c.decision)]);
	const gated = decisions.filter((d) => d.rules).map((d) => d.rules?.gate.confidence ?? 0);
	const hist = [
		["<0.5", gated.filter((c) => c < 0.5).length],
		["0.5–0.8", gated.filter((c) => c >= 0.5 && c < 0.8).length],
		["0.8–0.9", gated.filter((c) => c >= 0.8 && c < 0.9).length],
		["≥0.9", gated.filter((c) => c >= 0.9).length],
	] as const;
	const maxHist = Math.max(1, ...hist.map(([, n]) => n));
	let top = 0;
	let base = 0;
	let priceable = false;
	for (const task of timeline.tasks) {
		const t = priced(task, tierPrice(snapshot, snapshot?.topTier ?? ""));
		const b = priced(task, tierPrice(snapshot, snapshot?.baselineTier ?? ""));
		if (t !== undefined) {
			top += t;
			priceable = true;
		}
		if (b !== undefined) base += b;
	}
	const tiers = [...new Set(decisions.map((d) => d.tier.chosen).filter(Boolean))];
	const members = [...byMember.keys()];
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--dim:#6b6b66;--line:#e4e3df;--card:#fff;--accent:#2f5d50;--warn:#a1450f;--switch:#fff4e0}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#e9e8e3;--dim:#9a998f;--line:#2c2b28;--card:#1c1b19;--accent:#7cc0a8;--warn:#f0a35e;--switch:#2e2614}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;padding:16px;max-width:1200px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:24px 0 8px}
.dim{color:var(--dim)}.n{text-align:right;font-variant-numeric:tabular-nums}code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}.card b{display:block;font-size:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left}th{font-weight:600;color:var(--dim);font-size:12px}
tr.switch td{background:var(--switch)}tr.err td,li.err{color:var(--warn)}
.bar{display:flex;align-items:center;gap:8px}.bar span{display:inline-block;height:10px;background:var(--accent);border-radius:3px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}select,label{font:inherit}
details.task{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:6px 0}details.task>summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;cursor:pointer}
.idx{color:var(--dim);font-variant-numeric:tabular-nums}.req{flex:1 1 300px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{background:var(--accent);color:var(--bg);border-radius:10px;padding:0 8px;font-size:12px}.tag{border:1px solid var(--line);border-radius:10px;padding:0 6px;font-size:12px}.tag.warn{color:var(--warn);border-color:var(--warn)}
.body{padding:4px 12px 12px}details.decision{margin:4px 0}details.decision>summary{cursor:pointer;font-family:ui-monospace,Menlo,monospace;font-size:12px}details.decision.warn>summary{color:var(--warn)}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;margin:4px 0;overflow-x:auto}
ul.tools{margin:6px 0;padding-left:18px}.child{border-left:3px solid var(--accent);padding-left:10px;margin:8px 0}
</style></head><body>
<h1>${esc(title)}</h1><p class="dim mono">${esc(timeline.file ?? "")}${timeline.cwd ? ` · ${esc(timeline.cwd)}` : ""}</p>
<div class="cards">
<div class="card"><span class="dim">Cost</span><b>${money(timeline.totals.cost)}</b></div>
<div class="card"><span class="dim">Tokens</span><b>${tokens(timeline.totals.tokens)}</b></div>
<div class="card"><span class="dim">Tasks</span><b>${timeline.tasks.length}</b></div>
<div class="card"><span class="dim">Model switches</span><b>${timeline.totals.switches}</b></div>
<div class="card"><span class="dim">Fallback rate</span><b>${timeline.totals.decisions ? Math.round((100 * timeline.totals.fallbacks) / timeline.totals.decisions) : 0}%</b></div>
<div class="card"><span class="dim">If all on top tier</span><b>${priceable ? money(top) : "n/a"}</b><span class="dim">estimate</span></div>
<div class="card"><span class="dim">If all on baseline</span><b>${priceable ? money(base) : "n/a"}</b><span class="dim">estimate</span></div>
</div>
<div class="grid">
<div><h2>By tier</h2><table><thead><tr><th>tier</th><th>cost</th><th>tokens</th><th>responses</th></tr></thead><tbody>${rows(byTier)}</tbody></table></div>
<div><h2>By model</h2><table><thead><tr><th>model</th><th>cost</th><th>tokens</th><th>responses</th></tr></thead><tbody>${rows(byMember)}</tbody></table></div>
<div><h2>By provider</h2><table><thead><tr><th>provider</th><th>cost</th><th>tokens</th><th>responses</th></tr></thead><tbody>${rows(byProvider)}</tbody></table></div>
<div><h2>Gate confidence</h2>${hist.map(([label, n]) => `<div class="bar"><span style="width:${Math.round((160 * n) / maxHist)}px"></span>${esc(label)}: ${n}</div>`).join("")}</div>
</div>
<h2>Tasks</h2>
<div class="filters">
<label>Tier <select id="f-tier"><option value="">all</option>${tiers.map((t) => `<option>${esc(t)}</option>`).join("")}</select></label>
<label>Model <select id="f-member"><option value="">all</option>${members.map((m) => `<option>${esc(m)}</option>`).join("")}</select></label>
<label><input type="checkbox" id="f-fallback"> fallbacks only</label>
<label><input type="checkbox" id="f-switch"> switches only</label>
</div>
<div id="tasks">${timeline.tasks.map((task) => taskBlock(task, snapshot, 0)).join("") || '<p class="dim">No tasks.</p>'}</div>
<script>
(() => {
  const get = (id) => document.getElementById(id);
  const apply = () => {
    const tier = get("f-tier").value, member = get("f-member").value, fb = get("f-fallback").checked, sw = get("f-switch").checked;
    for (const el of document.querySelectorAll("#tasks > details.task")) {
      const show = (!tier || el.dataset.tier === tier) && (!member || el.dataset.member === member) && (!fb || el.dataset.fallback === "true") && (!sw || el.dataset.switch === "true");
      el.style.display = show ? "" : "none";
    }
  };
  for (const id of ["f-tier", "f-member", "f-fallback", "f-switch"]) get(id).addEventListener("change", apply);
})();
</script>
</body></html>`;
}
