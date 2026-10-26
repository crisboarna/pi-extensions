// Prepares a pi-switchboard terminal scene for tools/media/render.mjs: a
// throwaway pi agent folder with demo providers, pi-subagents and a routing
// config, a small project to work in, and the fake classifier and providers
// the scene scripts. pi, pi-switchboard and pi-subagents are the real code.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type LlmScript, startLlm } from "../../../../tools/media/terminal-kit/fake-llm.ts";
import { createSceneHome, piCommand } from "../../../../tools/media/terminal-kit/home.ts";
import { type ScriptedAnswer, startClassifier } from "./fake-classifier.ts";

export interface SceneScript {
	answers: ScriptedAnswer[];
	llm: LlmScript;
	/** Write a routing config before pi starts (default true); the init clip starts without one. */
	config?: boolean;
}

/** Placeholder accounts and models, priced like small, mid-size and large hosted models (per million tokens). */
export const PROVIDERS: Record<string, string[]> = {
	"provider-a": ["small-model", "mid-model", "big-model"],
	"provider-b": ["small-model", "mid-model", "big-model"],
	"provider-c": ["mid-model"],
};
const PRICES: Record<string, { input: number; output: number }> = {
	"small-model": { input: 0.25, output: 1.25 },
	"mid-model": { input: 3, output: 15 },
	"big-model": { input: 15, output: 75 },
};

export const CONFIG = (classifierUrl: string) => ({
	classifierProviders: [{ name: "lmstudio", baseUrl: classifierUrl, models: ["h2o-lightning-4b"] }],
	classifiers: [{ model: "lmstudio/h2o-lightning-4b", timeoutMs: 2000, threshold: 0.85 }],
	profiles: {
		work: {
			tiers: {
				light: { rank: 1, members: ["provider-a/small-model", "provider-b/small-model"] },
				standard: { rank: 2, members: ["provider-a/mid-model", "provider-b/mid-model", "provider-c/mid-model"], strategy: "ordered" },
				deep: { rank: 3, members: ["provider-a/big-model", "provider-b/big-model"], strategy: "ordered" },
			},
			fallbackTier: "standard",
		},
	},
	profileSelection: { default: "work" },
});

export const providerExtension = (llmUrl: string) => `// Demo accounts for the recording; every request goes to the scene's fake provider.
const PROVIDERS = ${JSON.stringify(PROVIDERS)};
const PRICES = ${JSON.stringify(PRICES)};
export default function demoProviders(pi) {
	for (const [name, ids] of Object.entries(PROVIDERS)) {
		pi.registerProvider(name, {
			name, baseUrl: "${llmUrl}/" + name + "/v1", apiKey: "demo", api: "openai-completions",
			models: ids.map((id) => ({ type: "chat", id, name: id, reasoning: false, input: ["text"], cost: { ...PRICES[id], cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 })),
		});
	}
}
`;

export const PROJECT: Record<string, string> = {
	"package.json": '{ "name": "acme-shop", "private": true, "type": "module" }\n',
	"src/upload/client.ts":
		"export async function upload(file: Blob): Promise<void> {\n\tfor (let attempt = 0; attempt < 3; attempt++) {\n\t\tif ((await fetch('/upload', { method: 'POST', body: file })).ok) return;\n\t}\n\tthrow new Error('upload failed');\n}\n",
	"src/pricing/api.ts": "export async function price(sku: string): Promise<number> {\n\treturn (await (await fetch('/prices/' + sku)).json()).amount;\n}\n",
	"src/utils.ts": "export const foo = (value: string): string => value.trim();\n",
};

export default async function setup(item: { scene: string }) {
	const packageDir = process.env.MEDIA_PACKAGE;
	if (!packageDir) throw new Error("setup: MEDIA_PACKAGE is not set; run through scripts/tools/media.ts");
	const repo = join(packageDir, "..", "..");
	const { scene } = (await import(pathToFileURL(join(import.meta.dirname, "scenes", `${item.scene}.ts`)).href)) as { scene: SceneScript };
	const classifier = await startClassifier(scene.answers);
	const llm = await startLlm(scene.llm);

	const sceneHome = createSceneHome();
	const { home, agentDir } = sceneHome;
	sceneHome.write(".pi/agent/extensions/demo-providers.js", providerExtension(llm.url));
	if (scene.config !== false) sceneHome.write(".pi/agent/pi-switchboard.json", `${JSON.stringify(CONFIG(classifier.url), null, "\t")}\n`);
	// pi-switchboard looks for pi-subagents where pi installs packages.
	mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
	const subagents = join(agentDir, "npm", "node_modules", "pi-subagents");
	symlinkSync(join(repo, "node_modules", "pi-subagents"), subagents);
	const project = join(home, "acme-shop");
	for (const [file, text] of Object.entries(PROJECT)) sceneHome.write(`acme-shop/${file}`, text);

	return {
		spawn: {
			...piCommand(repo, ["-e", join(packageDir, "src", "index.ts"), "-e", join(subagents, "bundle", "index.js"), "--model", "switchboard/auto"]),
			cwd: project,
			env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		},
		async close() {
			// MEDIA_KEEP=<folder> (relative to media/) keeps the scene's home: sessions and subagent run logs.
			sceneHome.close(item.scene, join(import.meta.dirname, ".."));
			classifier.server.close();
			llm.server.close();
		},
	};
}
