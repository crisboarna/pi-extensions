// Prepares a pi-context-refs terminal scene for tools/media/render.mjs: a
// throwaway home with a small git repository (one uncommitted change), a demo
// ref library, and a fake model provider whose replies the scene scripts. pi
// and the extension are the real code; nothing of the user's (refs, files,
// accounts) is ever read.
//
// Called by: media/manifest.json (as "setup"), media/data.ts (the demo files and library).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type LlmScript, startLlm } from "../../../../tools/media/terminal-kit/fake-llm.ts";
import { createSceneHome, piCommand } from "../../../../tools/media/terminal-kit/home.ts";

export interface RefsScene {
	llm: LlmScript;
	/** Start with the demo ref library saved; false starts with none, so the scene adds the first ref itself. */
	library?: boolean;
	/** Start a shell instead of pi, with `pi` on its PATH loading the extension. */
	shell?: boolean;
}

/** The demo repository, relative to the scene home. */
export const REPOSITORY = "projects/shop-api";
export const MODEL = "demo/demo-model";

export const API_SOURCE = `// The public API of the shop service.
import { retry } from "./retry.ts";

export interface Order {
	id: string;
	total: number;
	paid: boolean;
}

/** Fetches an order. A network error is retried twice. */
export function getOrder(id: string): Promise<Order> {
	return retry(() => fetchJson<Order>(\`/orders/\${id}\`), { times: 2 });
}

/** Marks an order paid. A network error is retried twice. */
export function payOrder(id: string): Promise<Order> {
	return retry(() => postJson<Order>(\`/orders/\${id}/pay\`), { times: 2 });
}
`;

export const RETRY_COMMITTED = `export async function retry<T>(run: () => Promise<T>, options: { times: number }): Promise<T> {
	let failure: unknown;
	for (let attempt = 0; attempt <= options.times; attempt++) {
		try {
			return await run();
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
}
`;

/** The uncommitted change that #diff sends: a wait between attempts, capped at one second. */
export const RETRY_CHANGED = `export async function retry<T>(run: () => Promise<T>, options: { times: number }): Promise<T> {
	let failure: unknown;
	for (let attempt = 0; attempt <= options.times; attempt++) {
		try {
			return await run();
		} catch (error) {
			failure = error;
			await sleep(Math.min(100 * 2 ** attempt, 1000));
		}
	}
	throw failure;
}
`;

/** The demo library the clips start with (the hero scene adds `api` itself). */
export const LIBRARY = [
	{ name: "api", kind: "file", path: "src/api.ts", description: "The public API" },
	{ name: "terse", kind: "snippet", text: "Answer in one sentence.", description: "Keep answers short" },
	{ name: "notes", kind: "path", path: "NOTES.md", description: "Working notes" },
];

/** Builds the demo repository under `dir`: one commit, then an uncommitted change to src/retry.ts. */
export function createDemoRepository(dir: string): void {
	const files: Record<string, string> = {
		"src/api.ts": API_SOURCE,
		"src/retry.ts": RETRY_COMMITTED,
		"NOTES.md": "# Notes\n\nShip the retry change this week.\n",
	};
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("commit", "-q", "-m", "Add the shop API");
	writeFileSync(join(dir, "src/retry.ts"), RETRY_CHANGED);
}

const providerExtension = (llmUrl: string) => `// A stand-in model for the recording; every request goes to the scene's fake provider.
export default function demoModel(pi) {
	pi.registerProvider("demo", {
		name: "demo", baseUrl: "${llmUrl}/demo/v1", apiKey: "stand-in", api: "openai-completions",
		models: [{ type: "chat", id: "demo-model", name: "demo-model", reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
	});
}
`;

export default async function setup(item: { scene: string; variant?: string }) {
	const packageDir = process.env.MEDIA_PACKAGE;
	if (!packageDir) throw new Error("setup: MEDIA_PACKAGE is not set; run through scripts/tools/media.ts");
	const repo = join(packageDir, "..", "..");
	const module = (await import(pathToFileURL(join(import.meta.dirname, "scenes", `${item.scene}.ts`)).href)) as Record<string, RefsScene>;
	const scene = module[item.variant ?? "scene"];
	if (!scene) throw new Error(`setup: scene ${item.scene} has no export ${item.variant ?? "scene"}`);
	const llm = await startLlm(scene.llm);
	const home = createSceneHome();
	home.write(".pi/agent/extensions/demo-model.js", providerExtension(llm.url));
	if (scene.library !== false) home.write(".pi/agent/pi-context-refs.json", `${JSON.stringify({ version: 1, refs: LIBRARY }, null, 2)}\n`);
	createDemoRepository(join(home.home, REPOSITORY));
	const pi = piCommand(repo, ["-e", join(packageDir, "src", "index.ts")]);
	if (scene.shell) home.write("bin/pi", `#!/bin/sh\nexec ${[pi.command, ...pi.args].map((word) => `'${word}'`).join(" ")} "$@"\n`, 0o755);
	return {
		spawn: {
			...(scene.shell ? { command: "bash", args: ["--noprofile", "--norc", "-i"] } : { command: pi.command, args: [...pi.args, "--model", MODEL] }),
			cwd: join(home.home, REPOSITORY),
			env: {
				HOME: home.home,
				...(scene.shell ? { PATH: `${join(home.home, "bin")}:/usr/local/bin:/usr/bin:/bin`, PS1: "\\w $ ", HISTFILE: "/dev/null" } : {}),
				PI_CODING_AGENT_DIR: home.agentDir,
				PI_OFFLINE: "1",
			},
		},
		async close() {
			// MEDIA_KEEP=<folder> (relative to media/) keeps the scene's home.
			home.close(item.variant ?? item.scene, join(import.meta.dirname, ".."));
			llm.server.close();
		},
	};
}
