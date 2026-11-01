// Registers the real providers the tiers of `harness.ts` BASE_CONFIG name (`acme`, `zen`), answering locally, so real
// interactive pi can run in the test process with no network and no credentials. Inline extension factory: `tui-session.ts`.
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TUI_REPLY = "tui stub reply";
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function streamStub(model: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) {
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
	queueMicrotask(() => {
		if (options?.signal?.aborted) {
			stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "aborted" } });
			stream.end();
			return;
		}
		stream.push({ type: "start", partial: message });
		message.content = [{ type: "text", text: TUI_REPLY }];
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: TUI_REPLY, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: TUI_REPLY, partial: message });
		message.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8000,
	maxTokens: 1000,
});

export default function tuiStubProviders(pi: ExtensionAPI): void {
	for (const [name, models] of [
		["acme", ["small", "mid", "big"]],
		["zen", ["mid"]],
	] as const) {
		pi.registerProvider(name, {
			name,
			baseUrl: "http://stub.invalid",
			apiKey: "stub-not-a-secret",
			api: `stub-api-${name}`,
			streamSimple: streamStub,
			models: models.map(model),
		});
	}
}
