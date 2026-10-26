// A second stub provider, so a smoke test has an account to Switch to. Load it
// next to the stub provider with `-e`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STUB_MODEL, streamStub } from "./stub-provider.ts";

export const SECOND_PROVIDER = "stubtwo";
export const SECOND_ONLY_MODEL = "stubtwo-only";

export default function secondProvider(pi: ExtensionAPI): void {
	pi.registerProvider(SECOND_PROVIDER, {
		name: "Stub two",
		baseUrl: "http://stub.invalid",
		apiKey: "stub-not-a-secret",
		api: "stub-api-two",
		streamSimple: streamStub,
		models: [SECOND_ONLY_MODEL, STUB_MODEL].map((id) => ({
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
