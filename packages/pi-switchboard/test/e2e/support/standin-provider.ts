// A stand-in chat provider for the end-to-end suites: a pi extension with two
// providers, alpha and beta, so two accounts exist, of three models each. It
// answers with no network. A test scripts each model's replies in the JSON file
// named by STANDIN_SCRIPT, read on every request so a test can change them
// mid-session, and every request is appended to the JSONL file named by
// STANDIN_LOG. Suites install it beside pi-switchboard through settings.json
// `extensions`. pi-account-guard's test/support/stub-provider.ts works the same
// way; a package may not import another's files.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** This file, for settings.json `extensions`. */
export const STANDIN_EXTENSION = fileURLToPath(import.meta.url);
const PROVIDERS = ["alpha", "beta"] as const;
const MODELS = ["small", "mid", "big"] as const;

/**
 * One scripted reply: wait `delayMs` (the request's abort cuts it short), then
 * fail with `error` as the provider's message, call a tool, or answer `text`.
 * The default answer names the model: `standin alpha/big`.
 */
export interface Step {
	delayMs?: number;
	error?: string;
	toolCall?: { name: string; arguments: ToolCall["arguments"] };
	text?: string;
}

/** Each model's replies in order, as `provider/id`; a model past its list, or not in it, gives the default answer. */
export interface Script {
	/** Raise it to start every model's list again from its first step. */
	epoch?: number;
	models?: Record<string, Step[]>;
}

/** One request as the stand-in saw it. */
export interface Request {
	model: string;
	/** Which step of the model's list answered, counted from the script's epoch; past the list, the default answer. */
	step: number;
	/** The last user message's text. */
	user: string;
	/** Whether the request carries a tool result, which pi sends after running a scripted tool call. */
	afterTool: boolean;
	at: number;
}

export function writeScript(path: string, script: Script): void {
	writeFileSync(path, `${JSON.stringify(script)}\n`);
}

/** Every request logged at `path` so far. */
export function readRequests(path: string): Request[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Request);
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let epoch: number | undefined;
const served = new Map<string, number>();

function readScript(): Script {
	const path = process.env.STANDIN_SCRIPT;
	return path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Script) : {};
}

function userText(context: TranscriptContext): string {
	const user = [...context.messages].reverse().find((message) => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string" ? user.content : user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The next step for `model`, and its place in the model's list. */
function nextStep(model: string): { step: Step; index: number } {
	const script = readScript();
	if (script.epoch !== epoch) {
		epoch = script.epoch;
		served.clear();
	}
	const index = served.get(model) ?? 0;
	served.set(model, index + 1);
	return { step: script.models?.[model]?.[index] ?? {}, index };
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((done) => {
		if (signal?.aborted) return done();
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			done();
		});
	});
}

function streamStandin(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	const id = `${model.provider}/${model.id}`;
	const { step, index } = nextStep(id);
	const request: Request = {
		model: id,
		step: index,
		user: userText(context),
		afterTool: context.messages.some((message) => message.role === "toolResult"),
		at: Date.now(),
	};
	if (process.env.STANDIN_LOG) appendFileSync(process.env.STANDIN_LOG, `${JSON.stringify(request)}\n`);
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...NO_COST } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	void (async () => {
		if (step.delayMs) await wait(step.delayMs, options?.signal);
		if (options?.signal?.aborted) {
			stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "aborted" } });
		} else if (step.error !== undefined) {
			stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: step.error } });
		} else if (step.toolCall) {
			const call: ToolCall = { type: "toolCall", id: `call-${request.at}-${index}`, name: step.toolCall.name, arguments: {} };
			message.content = [call];
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.toolCall.arguments), partial: message });
			const done: ToolCall = { ...call, arguments: step.toolCall.arguments };
			message.content = [done];
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: done, partial: message });
			message.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message });
		} else {
			const text = step.text ?? `standin ${id}`;
			stream.push({ type: "start", partial: message });
			message.content = [{ type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			message.content = [{ type: "text", text }];
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		}
		stream.end();
	})();
	return stream;
}

export default function standinProvider(pi: ExtensionAPI): void {
	for (const provider of PROVIDERS)
		pi.registerProvider(provider, {
			name: `Stand-in ${provider}`,
			baseUrl: `http://${provider}.invalid`,
			apiKey: "standin-not-a-secret",
			api: "standin-api",
			streamSimple: streamStandin,
			models: MODELS.map((id) => ({
				id,
				name: `${provider} ${id}`,
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 2000,
			})),
		});
}
