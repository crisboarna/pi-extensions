// A stub model provider for smoke tests. It answers every prompt locally, so real
// pi can run a full turn with no network and no credentials. Load it with
// `pi -ne -e test/support/stub-provider.ts`.
import { appendFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STUB_PROVIDER = "stub";
export const STUB_MODEL = "stub-model";
export const STUB_MODEL_2 = "stub-model-2";
export const STUB_REPLY = "stub reply";

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function streamStub(model: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) {
	// Smoke tests set STUB_REQUEST_LOG to count the requests that reach the provider.
	if (process.env.STUB_REQUEST_LOG) appendFileSync(process.env.STUB_REQUEST_LOG, `${model.id}\n`);
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
		message.content = [{ type: "text", text: "" }];
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		message.content = [{ type: "text", text: STUB_REPLY }];
		stream.push({ type: "text_delta", contentIndex: 0, delta: STUB_REPLY, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: STUB_REPLY, partial: message });
		message.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

export default function stubProvider(pi: ExtensionAPI): void {
	pi.registerProvider(STUB_PROVIDER, {
		name: "Stub",
		baseUrl: "http://stub.invalid",
		apiKey: "stub-not-a-secret",
		api: "stub-api",
		streamSimple: streamStub,
		models: [STUB_MODEL, STUB_MODEL_2].map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8000,
			maxTokens: 1000,
		})),
	});
}
