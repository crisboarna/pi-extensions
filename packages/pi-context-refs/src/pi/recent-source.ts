import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createUsedFiles, messagePaths, type PathEnv, toolUse, type Use, type UsedFiles } from "../core/recent.ts";

/** What the files the session used need from outside pi, so tests can stand in for the machine. */
export interface RecentDeps {
	home: string;
	/** The directory pi writes its temporary files to. */
	tmpdir: string;
	/** The time of a use that has no stored time, in milliseconds. */
	now: () => number;
}

interface TimedUse {
	path: string;
	use: Use;
	at: number;
}

const pathEnv = (ctx: Pick<ExtensionContext, "cwd">, deps: RecentDeps): PathEnv => ({ cwd: ctx.cwd, home: deps.home, tmpdir: deps.tmpdir });

/** The text of a user message, whether pi stored it as a string or as parts. */
function userText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

type Message = Extract<SessionEntry, { type: "message" }>["message"];
type Calls = Map<string, { name: string; input: unknown }>;

/** The files a tool result used: its own call, found by id among the calls the assistant made, and the calls a codemode script made. */
function resultUses(message: Extract<Message, { role: "toolResult" }>, calls: Calls, env: PathEnv): Array<{ path: string; use: Use }> {
	const call = calls.get(message.toolCallId);
	const own = message.isError || !call ? undefined : toolUse(message.toolName, call.input, env);
	const nested = (message.nestedCalls?.calls ?? []).map((made) => (made.status === "ok" ? toolUse(made.name, made.arguments, env) : undefined));
	return [own, ...nested].filter((used) => used !== undefined);
}

/**
 * The files the current branch used, with the stored time of each use. A tool result does not carry the call's path, so the path comes from the
 * assistant message that made the call; a codemode result carries the calls it made as `nestedCalls`.
 */
function branchUses(entries: readonly SessionEntry[], env: PathEnv): TimedUse[] {
	const calls: Calls = new Map();
	const uses: TimedUse[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const { message } = entry;
		const at = Number.isFinite(message.timestamp) ? message.timestamp : Date.parse(entry.timestamp);
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, input: part.arguments });
		} else if (message.role === "toolResult") {
			for (const used of resultUses(message, calls, env)) uses.push({ ...used, at });
		} else if (message.role === "user") {
			for (const path of messagePaths(userText(message.content), env)) uses.push({ path, use: "read", at });
		}
	}
	return uses;
}

/**
 * Keeps the session's Recent refs in memory: rebuilt from the branch at `session_start` and `session_tree`, then updated from each successful
 * `read`, `edit` and `write` result (a codemode script's nested calls raise their own results) and from `@path` in each message that is sent.
 * Nothing is written to disk and earlier sessions are never read.
 */
export function registerRecentSource(pi: ExtensionAPI, deps: RecentDeps): UsedFiles {
	const used = createUsedFiles();

	const rebuild = (ctx: ExtensionContext): void => {
		try {
			used.rebuild(branchUses(ctx.sessionManager.getBranch(), pathEnv(ctx, deps)));
		} catch {
			// Recent refs are a convenience; a branch that cannot be read leaves the set empty rather than breaking the session.
			used.rebuild([]);
		}
	};
	pi.on("session_start", (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));
	pi.on("session_shutdown", () => used.rebuild([]));

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		const call = toolUse(event.toolName, event.input, pathEnv(ctx, deps));
		if (call) used.record(call.path, call.use, deps.now());
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		for (const path of messagePaths(event.text, pathEnv(ctx, deps))) used.record(path, "read", deps.now());
	});

	return used;
}
