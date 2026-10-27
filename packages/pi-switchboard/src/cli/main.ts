import { readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { responseCount, summarize } from "../record/describe.ts";
import { DECISION_TYPE, type DecisionEntry } from "../record/types.ts";
import { liveChildMirror, liveDirOf } from "../timeline/mirror.ts";
import { aggregate, readEntries, type Timeline, timelineFromFile } from "../timeline/parse.ts";
import { renderInspector } from "./inspector.ts";

/** Subagent transcript mirrors live next to the other pi-switchboard data. */
const childMirror = () => liveChildMirror(liveDirOf(join(homedir(), ".pi", "agent", "pi-switchboard")));

const USAGE = `pi-switchboard <command>

  replay <session.jsonl> [--json] [--reclassify]   Timeline of tasks, decisions, models and tool calls
  inspect <session.jsonl> [-o file.html]           Write the offline HTML inspector
  report [--since 7d] [--sessions <dir>]           Cost by tier, model and provider across sessions
  classifier detect                                Find local classifier servers and print the config
  classifier setup <server>                        Set up a local classifier server and add it to the config
  classifier eval <baseUrl> <model>                Test a classifier on 24 labelled requests (classifier --help)
`;

function money(value: number): string {
	return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function formatReplay(timeline: Timeline): string {
	const lines: string[] = [];
	lines.push(
		`session ${timeline.sessionId ?? "?"} · ${timeline.tasks.length} tasks · ${money(timeline.totals.cost)} · ${timeline.totals.switches} model switches`,
	);
	const visit = (t: Timeline, indent: string) => {
		for (const task of t.tasks) {
			lines.push(`${indent}task ${task.index}: ${task.request.replace(/\s+/gu, " ").slice(0, 100)}`);
			for (const decision of task.decisions) lines.push(`${indent}  ${summarize(decision)}`);
			for (const request of task.requests) {
				lines.push(
					`${indent}  → ${request.provider}/${request.model}${request.thinking ? `:${request.thinking}` : ""} ${request.input}+${request.cacheRead} in / ${request.output} out ${money(request.cost)}${request.switched ? " [switch]" : ""}${request.error ? ` ✗ ${request.error.slice(0, 80)}` : ""}`,
				);
			}
			for (const tool of task.tools) lines.push(`${indent}  ${tool.isError ? "✗" : "✓"} ${tool.name}`);
			for (const child of task.children) {
				lines.push(`${indent}  ⤷ ${summarize(child.decision)}${child.runId ? ` (run ${child.runId})` : ""}`);
				if (child.timeline) visit(child.timeline, `${indent}    `);
			}
		}
	};
	visit(timeline, "");
	return lines.join("\n");
}

function parseSince(text: string | undefined): number {
	const match = /^(\d+)([hd])$/u.exec(text ?? "7d");
	const amount = Number(match?.[1] ?? 7);
	return Date.now() - amount * (match?.[2] === "h" ? 3_600_000 : 86_400_000);
}

function sessionFiles(dir: string, since: number): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(d, name);
			let stat: import("node:fs").Stats;
			try {
				stat = statSync(path);
			} catch {
				continue;
			}
			if (stat.isDirectory() && depth < 4) walk(path, depth + 1);
			else if (name.endsWith(".jsonl") && stat.mtimeMs >= since) out.push(path);
		}
	};
	walk(dir, 0);
	return out;
}

/** Re-runs the classifier on recorded evidence; needs pi's model registry, loaded lazily. */
async function reclassify(file: string): Promise<string[]> {
	const { reclassifyDecisions } = await import("./reclassify.ts");
	const decisions = readEntries(file)
		.filter((e) => e.type === "custom" && e.customType === DECISION_TYPE)
		.map((e) => e.data as DecisionEntry);
	return reclassifyDecisions(decisions);
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const flag = (name: string) => {
		const index = rest.indexOf(name);
		return index >= 0 ? rest[index + 1] : undefined;
	};
	const file = rest.find((arg, i) => !arg.startsWith("-") && !["-o", "--since", "--sessions"].includes(rest[i - 1] ?? ""));
	if (command === "--help" || command === "-h" || command === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	if (command === "classifier") {
		const { classifierCommand } = await import("./classifier.ts");
		return classifierCommand(rest, { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text), env: process.env });
	}
	switch (command) {
		case "replay": {
			if (!file) break;
			const timeline = timelineFromFile(resolve(file), { childMirror: childMirror() });
			process.stdout.write(rest.includes("--json") ? `${JSON.stringify(timeline, null, 2)}\n` : `${formatReplay(timeline)}\n`);
			if (rest.includes("--reclassify")) process.stdout.write(`${(await reclassify(resolve(file))).join("\n")}\n`);
			return 0;
		}
		case "inspect": {
			if (!file) break;
			const out = resolve(flag("-o") ?? `${file.replace(/\.jsonl$/u, "")}.switchboard.html`);
			writeFileSync(out, renderInspector(timelineFromFile(resolve(file), { childMirror: childMirror() })));
			process.stdout.write(`${out}\n`);
			return 0;
		}
		case "report": {
			const dir = flag("--sessions") ?? join(homedir(), ".pi", "agent", "sessions");
			const since = parseSince(flag("--since"));
			const totals = new Map<string, Map<string, { cost: number; tokens: number; requests: number }>>();
			let cost = 0;
			let files = 0;
			for (const path of sessionFiles(dir, since)) {
				const timeline = timelineFromFile(path);
				if (timeline.totals.decisions === 0) continue;
				files++;
				cost += timeline.totals.cost;
				for (const [name, key] of [
					["tier", (_r: unknown, d: DecisionEntry | undefined) => d?.tier.chosen || "unrouted"],
					["model", (r: { provider: string; model: string }) => `${r.provider}/${r.model}`],
					["provider", (r: { provider: string }) => r.provider],
				] as const) {
					const into = totals.get(name) ?? new Map();
					for (const [k, v] of aggregate(timeline, key as never)) {
						const row = into.get(k) ?? { cost: 0, tokens: 0, requests: 0 };
						row.cost += v.cost;
						row.tokens += v.tokens;
						row.requests += v.requests;
						into.set(k, row);
					}
					totals.set(name, into);
				}
			}
			const lines = [`${files} routed sessions since ${new Date(since).toISOString().slice(0, 10)} · ${money(cost)}`];
			for (const [name, rows] of totals) {
				lines.push(`by ${name}:`);
				for (const [k, v] of [...rows.entries()].sort((a, b) => b[1].cost - a[1].cost))
					lines.push(`  ${k}: ${money(v.cost)}, ${v.tokens} tokens, ${responseCount(v.requests)}`);
			}
			process.stdout.write(`${lines.join("\n")}\n`);
			return 0;
		}
	}
	process.stderr.write(USAGE);
	return command ? 1 : 0;
}
