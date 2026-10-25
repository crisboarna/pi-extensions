// Test-only extension: registers LM Studio's local chat models as a pi
// provider, so routing can be exercised end to end without spending any
// subscription quota. Load it with `-e test/support/lmstudio-chat.ts`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODELS = (process.env.LMSTUDIO_CHAT_MODELS ?? "google/gemma-4-e4b").split(",").filter(Boolean);

export default function lmstudioChat(pi: ExtensionAPI): void {
	pi.registerProvider("lmchat", {
		name: "LM Studio (test)",
		baseUrl: process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
		apiKey: "lm-studio",
		api: "openai-completions",
		models: MODELS.map((id) => ({
			type: "chat" as const,
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4096,
		})),
	});
}
