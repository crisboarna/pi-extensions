// Prepares a pi-switchboard terminal scene for tools/media/render.mjs: a
// throwaway pi agent folder with demo providers, pi-subagents and a routing
// config, a small project to work in, and the fake classifier and providers
// the scene scripts. pi, pi-switchboard and pi-subagents are the real code.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ScriptedAnswer, startClassifier } from "./fake-classifier.ts";
import { type LlmScript, startLlm } from "./fake-llm.ts";

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

const providerExtension = (llmUrl: string) => `// Demo accounts for the recording; every request goes to the scene's fake provider.
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

const PROJECT: Record<string, string> = {
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

	const home = mkdtempSync(join(tmpdir(), "scene-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "demo-providers.js"), providerExtension(llm.url));
	// pi looks for fd and ripgrep here before downloading them; the scenes never search files.
	mkdirSync(join(agentDir, "bin"));
	for (const tool of ["fd", "rg"]) writeFileSync(join(agentDir, "bin", tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ quietStartup: "header", defaultThinkingLevel: "medium" }, null, "\t")}\n`);
	if (scene.config !== false) writeFileSync(join(agentDir, "pi-switchboard.json"), `${JSON.stringify(CONFIG(classifier.url), null, "\t")}\n`);
	// pi-switchboard looks for pi-subagents where pi installs packages.
	const subagents = join(agentDir, "npm", "node_modules", "pi-subagents");
	symlinkSync(join(repo, "node_modules", "pi-subagents"), subagents);
	const project = join(home, "acme-shop");
	for (const [file, text] of Object.entries(PROJECT)) {
		mkdirSync(join(project, file, ".."), { recursive: true });
		writeFileSync(join(project, file), text);
	}

	return {
		spawn: {
			command: process.execPath,
			args: [
				join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
				"-e",
				join(packageDir, "src", "index.ts"),
				"-e",
				join(subagents, "bundle", "index.js"),
				"--model",
				"switchboard/auto",
			],
			cwd: project,
			env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		},
		async close() {
			// MEDIA_KEEP=<folder> keeps the scene's home (sessions, subagent run logs) for debugging.
			if (process.env.MEDIA_KEEP) {
				const keep = join(process.env.MEDIA_KEEP, item.scene);
				mkdirSync(keep, { recursive: true });
				spawnSync("sh", ["-c", `tar -C "${home}" --exclude=./.pi/agent/npm -cf - . | tar -C "${keep}" -xf -`]);
			}
			classifier.server.close();
			llm.server.close();
			rmSync(home, { recursive: true, force: true });
		},
	};
}
