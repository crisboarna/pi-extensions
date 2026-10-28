import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClassifyFn, isLocalClassifier } from "../../src/classifier/pi-adapter.ts";

const providers = [
	{ name: "ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["tev1", "clef:cloud", "clef-flash:cloud"] },
	{ name: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", models: ["h2o-lightning-4b"] },
	{ name: "lab", baseUrl: "http://192.168.1.20:8080/v1", models: ["kev"] },
];
/** A context whose registry knows pi's built-in hosted classifier and a llama.cpp router on this machine. */
const ctx = {
	modelRegistry: {
		findOfType: (_type: string, provider: string, id: string) =>
			provider === "openai" && id === "gpt-6-luna"
				? { baseUrl: "https://api.openai.com/v1" }
				: provider === "llama.cpp"
					? { baseUrl: "http://127.0.0.1:8080/v1" }
					: undefined,
	},
} as never;

describe("which classifiers count as local", () => {
	it("trusts a configured server on this machine", () => {
		assert.equal(isLocalClassifier(ctx, "ollama/tev1", providers), true);
		assert.equal(isLocalClassifier(ctx, "lmstudio/h2o-lightning-4b", providers), true);
		assert.equal(isLocalClassifier(ctx, "llama.cpp/Kev-4B", providers), true);
	});

	it("counts a server on another host and pi's hosted classifiers as remote", () => {
		assert.equal(isLocalClassifier(ctx, "lab/kev", providers), false);
		assert.equal(isLocalClassifier(ctx, "openai/gpt-6-luna", providers), false);
		assert.equal(isLocalClassifier(ctx, "nowhere/model", providers), false);
	});

	it("counts Ollama's cloud models as remote, though the local server relays them", () => {
		assert.equal(isLocalClassifier(ctx, "ollama/clef:cloud", providers), false);
		assert.equal(isLocalClassifier(ctx, "ollama/clef-flash:cloud", providers), false);
		assert.equal(isLocalClassifier(ctx, "ollama/gpt-oss:120b-cloud", providers), false);
	});
});

describe("a classifier pi does not list", () => {
	it("fails with that, not with a guess about credentials: pi lists a classifier whether or not its key is set", async () => {
		const result = await createClassifyFn(() => ctx)("nowhere/model", { state: {}, questions: {} } as never, { signal: new AbortController().signal });
		assert.deepEqual(result, { stopReason: "error", errorMessage: "classifier nowhere/model is not listed by pi" });
	});
});
