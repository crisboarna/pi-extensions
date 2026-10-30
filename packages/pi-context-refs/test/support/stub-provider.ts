// A stub model provider for the smoke and integration tests. It answers locally, so
// real pi can run a full turn with no network and no credentials, and it echoes the
// last user message it received, so a test asserts what the model got. Load it with
// `pi -ne -e test/support/stub-provider.ts`.
//
// Environment, all optional:
//   STUB_RECEIVED_LOG  JSONL file; one `{ text, images }` line per request, the last user message
//   STUB_DELAY_MS      wait this long before answering, so a test can queue a steer or follow-up
//   STUB_QUIET         answer QUIET_REPLY instead of echoing, for tests that read the screen and must not see the echo
//   STUB_TOOL_CALL     JSON `{ name, arguments }`; the first request after a user message asks for this tool call
import { appendFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STUB_PROVIDER = "stub";
export const STUB_MODEL = "stub-model";
export const REPLY_PREFIX = "MODEL-SAW ";
export const QUIET_REPLY = `${REPLY_PREFIX}(quiet)`;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export interface Received {
	text: string;
	images: number;
}

/** The text and the image count of the last user message in the transcript. */
export function lastUserMessage(messages: readonly Message[]): Received {
	const user = messages.findLast((message) => message.role === "user");
	if (!user) return { text: "", images: 0 };
	if (typeof user.content === "string") return { text: user.content, images: 0 };
	return {
		text: user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
		images: user.content.filter((part) => part.type === "image").length,
	};
}

/** What the stub answers for a received message, so tests recompute nothing: the prefix and the JSON of the received message. */
export function replyFor(received: Received): string {
	return `${REPLY_PREFIX}${JSON.stringify(received)}`;
}

/** True when the transcript already holds a tool result after the last user message. */
function toolAnswered(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
}

function requestedToolCall(messages: readonly Message[]): ToolCall | undefined {
	const raw = process.env.STUB_TOOL_CALL;
	if (!raw || toolAnswered(messages)) return undefined;
	const { name, arguments: args } = JSON.parse(raw) as { name: string; arguments: ToolCall["arguments"] };
	return { type: "toolCall", id: "stub-call-1", name, arguments: args };
}

export function streamStub(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	const received = lastUserMessage(context.messages);
	if (process.env.STUB_RECEIVED_LOG) appendFileSync(process.env.STUB_RECEIVED_LOG, `${JSON.stringify(received)}\n`);
	const toolCall = requestedToolCall(context.messages);
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...NO_COST } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const answer = () => {
		if (options?.signal?.aborted) {
			stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "aborted" } });
			stream.end();
			return;
		}
		stream.push({ type: "start", partial: message });
		if (toolCall) {
			message.content = [toolCall];
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			message.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end();
			return;
		}
		const reply = process.env.STUB_QUIET ? QUIET_REPLY : replyFor(received);
		message.content = [{ type: "text", text: "" }];
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		message.content = [{ type: "text", text: reply }];
		stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
		message.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	};
	const delay = Number(process.env.STUB_DELAY_MS ?? 0);
	if (delay > 0) setTimeout(answer, delay);
	else queueMicrotask(answer);
	return stream;
}

/** Registers the stub provider on an extension API; shared by the extension file and the in-process integration tests. */
export function registerStubProvider(pi: ExtensionAPI): void {
	pi.registerProvider(STUB_PROVIDER, {
		name: "Stub",
		baseUrl: "http://stub.invalid",
		apiKey: "stub-not-a-secret",
		api: "stub-api",
		streamSimple: streamStub,
		models: [
			{
				id: STUB_MODEL,
				name: STUB_MODEL,
				reasoning: false,
				input: ["text" as const, "image" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8000,
				maxTokens: 1000,
			},
		],
	});
}

export default registerStubProvider;
