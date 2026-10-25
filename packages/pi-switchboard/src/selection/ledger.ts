import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Member } from "../config/types.ts";

/** One routed response's usage, as one line of usage.jsonl. */
export interface UsageEntry {
	/** ISO-8601 UTC. */
	ts: string;
	session: string;
	task: number;
	provider: string;
	model: string;
	tier?: string;
	profile?: string;
	scope?: "main" | "subagent";
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const ROTATE_BYTES = 20 * 1024 * 1024;

export class UsageLedger {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	append(entry: UsageEntry): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			if (existsSync(this.path) && statSync(this.path).size > ROTATE_BYTES) renameSync(this.path, `${this.path}.1`);
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch {
			// The ledger is advisory; routing never fails because of it.
		}
	}

	/** Entries newer than `since` (epoch ms), from the current and the previous file. */
	read(since = 0): UsageEntry[] {
		const entries: UsageEntry[] = [];
		for (const file of [`${this.path}.1`, this.path]) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const line of text.split("\n")) {
				if (!line) continue;
				try {
					const entry = JSON.parse(line) as UsageEntry;
					if (Date.parse(entry.ts) >= since) entries.push(entry);
				} catch {
					// Skip a torn line.
				}
			}
		}
		return entries;
	}
}

const WINDOW_UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseWindow(text: string): number | undefined {
	const match = /^(\d+)([mhd])$/u.exec(text.trim());
	return match?.[1] && match[2] ? Number(match[1]) * (WINDOW_UNIT[match[2]] ?? 0) : undefined;
}

/**
 * Quota headroom from the ledger against a member's own budget: the fraction
 * of the budget left in the current window, and when the window resets. Used
 * when no external quota data exists. Windows are aligned to the epoch.
 */
export function ledgerQuota(entries: readonly UsageEntry[], member: Member, now: number): { remaining: number; resetsAt: number; source: string } | undefined {
	const budget = member.budget;
	const windowMs = budget ? parseWindow(budget.window) : undefined;
	if (!budget || !windowMs || (budget.tokens === undefined && budget.costUsd === undefined)) return undefined;
	const start = Math.floor(now / windowMs) * windowMs;
	let tokens = 0;
	let cost = 0;
	for (const entry of entries) {
		if (entry.provider !== member.provider || entry.model !== member.id) continue;
		if (Date.parse(entry.ts) < start) continue;
		tokens += entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
		cost += entry.cost;
	}
	const fractions: number[] = [];
	if (budget.tokens) fractions.push(1 - tokens / budget.tokens);
	if (budget.costUsd) fractions.push(1 - cost / budget.costUsd);
	return { remaining: Math.max(0, Math.min(...fractions)), resetsAt: start + windowMs, source: "ledger" };
}
