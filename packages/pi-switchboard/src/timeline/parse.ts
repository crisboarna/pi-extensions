import { existsSync, readFileSync } from "node:fs";
import type { MirrorLine } from "../live/live.ts";
import { DECISION_TYPE, type DecisionEntry, LINK_TYPE, type LinkEntry, PROFILE_TYPE, type ProfileSnapshotEntry } from "../record/types.ts";

export interface RequestRecord {
	ts: string;
	provider: string;
	model: string;
	thinking?: string;
	stopReason?: string;
	error?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Milliseconds since the previous entry, a rough duration. */
	durationMs?: number;
	/** The physical model changed from the previous response: a prompt-cache miss. */
	switched: boolean;
}

export interface ToolRecord {
	ts: string;
	name: string;
	isError: boolean;
	/** First characters of the result, for the timeline. */
	preview: string;
}

export interface ChildRun {
	decision: DecisionEntry;
	runId?: string;
	sessionFile?: string;
	/** The child's own timeline, when its session file is available. */
	timeline?: Timeline;
}

export interface Task {
	index: number;
	ts: string;
	request: string;
	decisions: DecisionEntry[];
	requests: RequestRecord[];
	tools: ToolRecord[];
	children: ChildRun[];
	cost: number;
	tokens: number;
}

export interface Timeline {
	file?: string;
	sessionId?: string;
	parentSession?: string;
	cwd?: string;
	tasks: Task[];
	profiles: ProfileSnapshotEntry[];
	/** Set when the timeline was rebuilt from a child's transcript mirror instead of a session file. */
	mirror?: MirrorLine[];
	totals: { cost: number; tokens: number; switches: number; requests: number; fallbacks: number; decisions: number };
}

type Entry = Record<string, unknown> & { type?: string; customType?: string; data?: unknown; message?: Record<string, unknown>; timestamp?: string };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).join("\n");
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readEntries(file: string): Entry[] {
	const out: Entry[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Entry);
		} catch {
			// Torn line at the end of a live session.
		}
	}
	return out;
}

/**
 * Turns a pi session (JSONL) into tasks: each user message with its routing
 * decisions, model requests (tokens, cost, switches), tool calls and the
 * subagent runs it launched, parsed recursively when their files exist.
 */
export function buildTimeline(entries: readonly Entry[], options: { file?: string; depth?: number; childMirror?: (link: { decisionId: string; runId?: string; sessionFile?: string }) => Timeline | undefined } = {}): Timeline {
	const tasks: Task[] = [];
	const profiles: ProfileSnapshotEntry[] = [];
	const links = new Map<string, { runId?: string; sessionFile?: string }>();
	const timeline: Timeline = { tasks, profiles, totals: { cost: 0, tokens: 0, switches: 0, requests: 0, fallbacks: 0, decisions: 0 }, ...(options.file ? { file: options.file } : {}) };
	let current: Task | undefined;
	let lastModel: string | undefined;
	let lastTs: number | undefined;
	const pendingDecisions: DecisionEntry[] = [];

	const ensureTask = (ts: string): Task => {
		if (!current) {
			current = { index: tasks.length + 1, ts, request: "", decisions: [], requests: [], tools: [], children: [], cost: 0, tokens: 0 };
			tasks.push(current);
		}
		return current;
	};

	for (const entry of entries) {
		const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
		if (entry.type === "session") {
			if (typeof entry.id === "string") timeline.sessionId = entry.id;
			if (typeof entry.parentSession === "string") timeline.parentSession = entry.parentSession;
			if (typeof entry.cwd === "string") timeline.cwd = entry.cwd;
			continue;
		}
		if (entry.type === "custom" && entry.customType === LINK_TYPE) {
			for (const link of (entry.data as LinkEntry).links ?? []) links.set(link.decisionId, { ...(link.runId ? { runId: link.runId } : {}), ...(link.sessionFile ? { sessionFile: link.sessionFile } : {}) });
			continue;
		}
		if (entry.type === "custom" && entry.customType === PROFILE_TYPE) {
			profiles.push(entry.data as ProfileSnapshotEntry);
			continue;
		}
		if (entry.type === "custom" && entry.customType === DECISION_TYPE) {
			const decision = entry.data as DecisionEntry;
			timeline.totals.decisions++;
			if (decision.kind === "fallback") timeline.totals.fallbacks++;
			if (decision.reason === "user" && decision.scope === "main") pendingDecisions.push(decision);
			else if (decision.reason === "launch") ensureTask(decision.ts).children.push({ decision });
			else ensureTask(decision.ts).decisions.push(decision);
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		const role = message.role;
		const time = Date.parse(ts);
		const sinceLast = lastTs !== undefined && Number.isFinite(time) ? time - lastTs : undefined;
		if (Number.isFinite(time)) lastTs = time;
		if (role === "user") {
			current = { index: tasks.length + 1, ts, request: text(message.content).slice(0, 2000), decisions: [...pendingDecisions], requests: [], tools: [], children: [], cost: 0, tokens: 0 };
			pendingDecisions.length = 0;
			tasks.push(current);
			continue;
		}
		if (role === "assistant") {
			const task = ensureTask(ts);
			if (pendingDecisions.length) task.decisions.push(...pendingDecisions.splice(0));
			const usage = (message.usage ?? {}) as Record<string, unknown>;
			const model = `${String(message.provider ?? "")}/${String(message.model ?? "")}`;
			const record: RequestRecord = {
				ts,
				provider: String(message.provider ?? ""),
				model: String(message.model ?? ""),
				...(typeof message.thinkingLevel === "string" ? { thinking: message.thinkingLevel } : {}),
				...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
				...(typeof message.errorMessage === "string" ? { error: message.errorMessage.slice(0, 300) } : {}),
				input: num(usage.input),
				output: num(usage.output),
				cacheRead: num(usage.cacheRead),
				cacheWrite: num(usage.cacheWrite),
				cost: num((usage.cost as Record<string, unknown> | undefined)?.total),
				...(sinceLast !== undefined ? { durationMs: sinceLast } : {}),
				switched: lastModel !== undefined && lastModel !== model,
			};
			lastModel = model;
			task.requests.push(record);
			task.cost += record.cost;
			task.tokens += record.input + record.output + record.cacheRead + record.cacheWrite;
			timeline.totals.cost += record.cost;
			timeline.totals.tokens += record.input + record.output + record.cacheRead + record.cacheWrite;
			timeline.totals.requests++;
			if (record.switched) timeline.totals.switches++;
			continue;
		}
		if (role === "toolResult") {
			ensureTask(ts).tools.push({ ts, name: String(message.toolName ?? "tool"), isError: message.isError === true, preview: text(message.content).slice(0, 300) });
		}
	}
	if (pendingDecisions.length && current) current.decisions.push(...pendingDecisions);

	const depth = options.depth ?? 0;
	for (const task of tasks) {
		for (const child of task.children) {
			const link = links.get(child.decision.id);
			if (link?.runId) child.runId = link.runId;
			if (link?.sessionFile) child.sessionFile = link.sessionFile;
			if (depth < 3 && link?.sessionFile && existsSync(link.sessionFile)) {
				child.timeline = buildTimeline(readEntries(link.sessionFile), { file: link.sessionFile, depth: depth + 1, ...(options.childMirror ? { childMirror: options.childMirror } : {}) });
			} else if (options.childMirror) {
				const mirrored = options.childMirror({ decisionId: child.decision.id, ...link });
				if (mirrored) child.timeline = mirrored;
			}
		}
	}
	return timeline;
}

export function timelineFromFile(file: string, options: Parameters<typeof buildTimeline>[1] = {}): Timeline {
	return buildTimeline(readEntries(file), { ...options, file });
}

/** Aggregates cost and tokens across tasks and their children by a key. */
export function aggregate(timeline: Timeline, key: (request: RequestRecord, decision: DecisionEntry | undefined) => string): Map<string, { cost: number; tokens: number; requests: number }> {
	const out = new Map<string, { cost: number; tokens: number; requests: number }>();
	const visit = (t: Timeline) => {
		for (const task of t.tasks) {
			const decision = task.decisions.at(-1);
			for (const request of task.requests) {
				const k = key(request, decision);
				const row = out.get(k) ?? { cost: 0, tokens: 0, requests: 0 };
				row.cost += request.cost;
				row.tokens += request.input + request.output + request.cacheRead + request.cacheWrite;
				row.requests++;
				out.set(k, row);
			}
			for (const child of task.children) if (child.timeline) visit(child.timeline);
		}
	};
	visit(timeline);
	return out;
}
