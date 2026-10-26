import { join } from "node:path";
import { findChildByDecision, type LiveStatus, type MirrorLine, readMirror } from "../live/live.ts";
import type { RequestRecord, Task, Timeline, ToolRecord } from "./parse.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A timeline for a child that left no session file (in-memory children), built
 * from its live status and transcript mirror. It has one task with one summed
 * request: the mirror keeps bounded text and tool calls, not per-request usage.
 */
export function timelineFromMirror(status: LiveStatus, lines: readonly MirrorLine[]): Timeline {
	const [provider = "", ...rest] = (status.model ?? "").split("/");
	const tools: ToolRecord[] = lines
		.filter((line) => line.kind === "tool-result")
		.map((line) => ({ ts: iso(line.ts), name: line.tool ?? "tool", isError: line.isError === true, preview: line.text.slice(0, 300) }));
	const request: RequestRecord = {
		ts: iso(status.startedAt),
		provider,
		model: rest.join("/"),
		stopReason: status.status === "error" ? "error" : "stop",
		input: status.tokens.input,
		output: status.tokens.output,
		cacheRead: status.tokens.cacheRead,
		cacheWrite: 0,
		cost: status.cost,
		...(status.endedAt ? { durationMs: status.endedAt - status.startedAt } : {}),
		switched: false,
	};
	const task: Task = {
		index: 1,
		ts: iso(status.startedAt),
		request: lines.find((line) => line.kind === "task")?.text.slice(0, 2000) ?? "",
		decisions: [],
		requests: [request],
		tools,
		children: [],
		cost: status.cost,
		tokens: status.tokens.input + status.tokens.output + status.tokens.cacheRead,
	};
	return {
		sessionId: status.session,
		tasks: [task],
		profiles: [],
		totals: { cost: status.cost, tokens: task.tokens, switches: 0, requests: 1, fallbacks: 0, decisions: 0 },
		mirror: [...lines],
	};
}

/** A `childMirror` callback for `buildTimeline` that reads the live directory. */
export function liveChildMirror(liveDir: string): (link: { decisionId: string }) => Timeline | undefined {
	return (link) => {
		const status = findChildByDecision(liveDir, link.decisionId);
		return status ? timelineFromMirror(status, readMirror(liveDir, status.session)) : undefined;
	};
}

export function liveDirOf(dataDir: string): string {
	return join(dataDir, "live");
}
