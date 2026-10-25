import { createHash } from "node:crypto";
import { createRedactor, redactDeep } from "./redact.ts";

/** The parts of pi's messages that evidence reads; kept loose so pure code needs no pi types. */
export interface TranscriptBlock {
	type: string;
	text?: string;
	name?: string;
}

export interface TranscriptMessage {
	role: string;
	content?: string | TranscriptBlock[];
	toolName?: string;
	isError?: boolean;
}

export type PlanPhase = "planning" | "executing" | "idle" | "unknown";

export interface EvidenceLimits {
	maxTokens: number;
	requestTokens: number;
	toolErrors: { max: number; chars: number };
}

export interface EvidenceInput {
	messages: readonly TranscriptMessage[];
	scope: "main" | "subagent";
	agent?: { name: string; tools?: string[] };
	planPhase: PlanPhase;
	limits: EvidenceLimits;
	redact?: string[];
	home?: string;
	/** Overrides the request text, for subagent tasks that are not yet a message. */
	request?: string;
	/** Tool names whose success counts as an edit. */
	editTools?: readonly string[];
}

export interface Evidence {
	state: Record<string, unknown>;
	/** Short hash of the redacted state, for matching decisions to replays. */
	digest: string;
	/** The beginning of the redacted request. */
	excerpt: string;
	/** Estimated tokens of the state (4 characters per token). */
	tokens: number;
	truncated: boolean;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_EDIT_TOOLS = ["edit", "write"];
const MAX_OUTCOMES = 10;
const EXCERPT_CHARS = 300;

export function textOf(content: string | TranscriptBlock[] | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Index of the last user message, or -1. */
export function lastUserIndex(messages: readonly TranscriptMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
	return -1;
}

/** Tool results since the last user message. */
export function toolResultsSinceUser(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
	return messages.slice(lastUserIndex(messages) + 1).filter((message) => message.role === "toolResult");
}

/** Keeps the head and tail of long text, marking what was dropped. */
export function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	const omitted = Math.ceil((text.length - maxChars) / CHARS_PER_TOKEN);
	return { text: `${text.slice(0, head)} […${omitted} tokens omitted…] ${text.slice(text.length - tail)}`, truncated: true };
}

/**
 * Builds the classifier state: evidence, not summaries (DESIGN.md 8.2). The
 * latest request (head and tail), the plan phase, outcomes and short errors of
 * the task's tool calls, and for subagents the agent and its tools. Everything
 * is redacted once and the whole state is held to the token budget.
 */
export function buildEvidence(input: EvidenceInput): Evidence {
	const redactor = createRedactor({ ...(input.home ? { home: input.home } : {}), extra: input.redact ?? [] });
	const editTools = new Set(input.editTools ?? DEFAULT_EDIT_TOOLS);
	const userIndex = lastUserIndex(input.messages);
	const rawRequest = input.request ?? textOf(input.messages[userIndex]?.content);
	const results = toolResultsSinceUser(input.messages);
	const previousStart = lastUserIndex(input.messages.slice(0, Math.max(0, userIndex)));
	const previousResults = userIndex > 0 ? input.messages.slice(previousStart + 1, userIndex).filter((m) => m.role === "toolResult") : [];

	const toolOutcomes = results.slice(-MAX_OUTCOMES).map((result) => ({ tool: result.toolName ?? "unknown", ok: !result.isError }));
	const toolErrors = results
		.filter((result) => result.isError)
		.slice(-input.limits.toolErrors.max)
		.map((result) => ({ tool: result.toolName ?? "unknown", error: textOf(result.content).slice(0, input.limits.toolErrors.chars) }));

	const base: Record<string, unknown> = {
		scope: input.scope,
		...(input.agent ? { agent: input.agent } : {}),
		planMode: input.planPhase,
		editsThisTask: results.some((result) => !result.isError && editTools.has(result.toolName ?? "")),
		...(previousResults.length > 0
			? { previousTask: { edits: previousResults.some((r) => !r.isError && editTools.has(r.toolName ?? "")), toolErrors: previousResults.filter((r) => r.isError).length } }
			: {}),
		...(toolOutcomes.length ? { toolOutcomes } : {}),
		...(input.limits.toolErrors.max > 0 && toolErrors.length ? { toolErrors } : {}),
	};
	const redactedBase = redactDeep(base, redactor);
	const request = redactor(rawRequest);

	const budget = input.limits.maxTokens * CHARS_PER_TOKEN;
	const baseChars = JSON.stringify(redactedBase).length;
	const requestBudget = Math.max(200, Math.min(input.limits.requestTokens * CHARS_PER_TOKEN, budget - baseChars - 32));
	const clipped = clip(request, requestBudget);
	const state = { ...redactedBase, request: clipped.text };
	const json = JSON.stringify(state);
	return {
		state,
		digest: createHash("sha256").update(json).digest("hex").slice(0, 16),
		excerpt: request.slice(0, EXCERPT_CHARS),
		tokens: Math.ceil(json.length / CHARS_PER_TOKEN),
		truncated: clipped.truncated,
	};
}
