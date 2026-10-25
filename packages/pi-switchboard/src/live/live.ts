import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../classifier/redact.ts";

/** One child's live status, written by the child itself (DESIGN.md 11.6). */
export interface LiveStatus {
	v: 1;
	session: string;
	/** Parent session file or id, from the child's header. */
	parent?: string;
	agent?: string;
	/** Digest of agent and task, to join the parent's launch decision. */
	taskDigest?: string;
	status: "running" | "done" | "error";
	launchModel?: string;
	model?: string;
	tier?: string;
	turn: number;
	currentTool?: string;
	tokens: { input: number; output: number; cacheRead: number };
	cost: number;
	tokensPerSecond?: number;
	/** Epoch ms. */
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	lastText?: string;
}

/** One line of a transcript mirror. */
export interface MirrorLine {
	ts: number;
	kind: "task" | "text" | "tool-call" | "tool-result" | "error";
	text: string;
	tool?: string;
	isError?: boolean;
}

export interface LiveLimits {
	textBytes: number;
	argBytes: number;
	toolResultBytes: number;
}

export const DEFAULT_LIMITS: LiveLimits = { textBytes: 8192, argBytes: 1024, toolResultBytes: 4096 };
const WRITE_INTERVAL_MS = 250;

function cap(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	return `${Buffer.from(text).subarray(0, bytes).toString("utf8")}…`;
}

/**
 * Writes a child's status file (atomically, at most every 250 ms) and appends
 * its bounded, redacted transcript mirror. Each child owns its own files, so
 * no lock is needed.
 */
export class LiveWriter {
	readonly status: LiveStatus;
	private readonly dir: string;
	private readonly redact: Redactor;
	private readonly limits: LiveLimits;
	private readonly mirror: boolean;
	private lastWrite = 0;
	private pending?: ReturnType<typeof setTimeout>;
	private streamStart?: number;

	constructor(options: { dir: string; session: string; parent?: string; redact: Redactor; limits?: Partial<LiveLimits>; mirror?: boolean; now?: number }) {
		this.dir = options.dir;
		this.redact = options.redact;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.mirror = options.mirror !== false;
		const now = options.now ?? Date.now();
		this.status = {
			v: 1,
			session: options.session,
			...(options.parent ? { parent: options.parent } : {}),
			status: "running",
			turn: 0,
			tokens: { input: 0, output: 0, cacheRead: 0 },
			cost: 0,
			startedAt: now,
			updatedAt: now,
		};
		mkdirSync(this.dir, { recursive: true });
	}

	private get statusPath(): string {
		return join(this.dir, `${safe(this.status.session)}.json`);
	}

	private get mirrorPath(): string {
		return join(this.dir, `${safe(this.status.session)}.jsonl`);
	}

	update(change: Partial<LiveStatus>, now = Date.now()): void {
		Object.assign(this.status, change, { updatedAt: now });
		this.schedule(now);
	}

	append(line: Omit<MirrorLine, "ts">, now = Date.now()): void {
		if (!this.mirror) return;
		const limit = line.kind === "tool-result" ? this.limits.toolResultBytes : line.kind === "tool-call" ? this.limits.argBytes : this.limits.textBytes;
		const entry: MirrorLine = { ts: now, ...line, text: cap(this.redact(line.text), limit) };
		try {
			appendFileSync(this.mirrorPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch {
			// Observability only.
		}
	}

	streamStarted(now = Date.now()): void {
		this.streamStart = now;
	}

	assistant(message: { provider?: string; model?: string; text: string; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } }; error?: string }, now = Date.now()): void {
		const usage = message.usage ?? {};
		const output = usage.output ?? 0;
		const seconds = this.streamStart ? (now - this.streamStart) / 1000 : 0;
		this.status.tokens.input += usage.input ?? 0;
		this.status.tokens.output += output;
		this.status.tokens.cacheRead += usage.cacheRead ?? 0;
		this.status.cost += usage.cost?.total ?? 0;
		if (seconds > 0.2 && output > 0) this.status.tokensPerSecond = Math.round(output / seconds);
		if (message.provider && message.model) this.status.model = `${message.provider}/${message.model}`;
		if (message.text) {
			this.status.lastText = cap(this.redact(message.text), 300);
			this.append({ kind: "text", text: message.text }, now);
		}
		if (message.error) this.append({ kind: "error", text: message.error }, now);
		this.update({}, now);
	}

	finish(status: "done" | "error", now = Date.now()): void {
		this.status.status = status;
		this.status.endedAt = now;
		delete this.status.currentTool;
		this.flush(now);
	}

	private schedule(now: number): void {
		if (now - this.lastWrite >= WRITE_INTERVAL_MS) {
			this.flush(now);
			return;
		}
		if (this.pending) return;
		this.pending = setTimeout(() => this.flush(Date.now()), WRITE_INTERVAL_MS);
		this.pending.unref?.();
	}

	flush(now = Date.now()): void {
		if (this.pending) clearTimeout(this.pending);
		this.pending = undefined;
		this.lastWrite = now;
		try {
			const temp = `${this.statusPath}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(this.status), { mode: 0o600 });
			renameSync(temp, this.statusPath);
		} catch {
			// Observability only.
		}
	}
}

function safe(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/gu, "_");
}

/** Live statuses of the children of `parent` (session file or id). */
export function readChildren(dir: string, parent: string | readonly string[]): LiveStatus[] {
	const parents = new Set(Array.isArray(parent) ? parent : [parent]);
	const out: LiveStatus[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const status = JSON.parse(readFileSync(join(dir, name), "utf8")) as LiveStatus;
			if (status.parent && parents.has(status.parent)) out.push(status);
		} catch {
			// Being rewritten.
		}
	}
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

export function readMirror(dir: string, session: string): MirrorLine[] {
	try {
		return readFileSync(join(dir, `${safe(session)}.jsonl`), "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as MirrorLine];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/** Deletes status files and mirrors of children that ended more than `retainHours` ago. */
export function sweep(dir: string, retainHours: number, now = Date.now()): number {
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	const limit = retainHours * 3_600_000;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		let ended: number | undefined;
		try {
			const status = JSON.parse(readFileSync(path, "utf8")) as LiveStatus;
			ended = status.endedAt ?? (now - status.updatedAt > limit * 2 ? status.updatedAt : undefined);
		} catch {
			ended = statSync(path).mtimeMs;
		}
		if (ended === undefined || now - ended < limit) continue;
		rmSync(path, { force: true });
		rmSync(path.replace(/\.json$/u, ".jsonl"), { force: true });
		removed++;
	}
	return removed;
}
