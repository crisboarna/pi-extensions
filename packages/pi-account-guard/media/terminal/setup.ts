// Prepares a pi-account-guard terminal scene for tools/media/render.mjs: a
// throwaway home with a work and a personal repository, three demo accounts
// on environment keys, the guard's config, and a fake model provider whose
// replies the scene scripts. pi and the guard are the real code; nothing of
// the user's (accounts, config, files) is ever read.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type LlmScript, startLlm } from "../../../../tools/media/terminal-kit/fake-llm.ts";
import { createSceneHome, piCommand } from "../../../../tools/media/terminal-kit/home.ts";

export interface GuardScene {
	llm: LlmScript;
	/** Which repository pi starts in. */
	place: keyof typeof REPOSITORIES;
	/** The model pi starts on, as provider/id. */
	model: string;
	/** Other extensions to load next to the guard. */
	with?: Array<"switchboard" | "powerline">;
	/** The guard's config; false for none (the defaults). */
	config?: Record<string, unknown> | false;
	/** Extra pi settings, such as powerline's customItems. */
	settings?: Record<string, unknown>;
	/** Register a stand-in provider under pi-claude-bridge's id, so the guard resolves its account as it does for the bridge. */
	bridge?: boolean;
	/** Extra environment for pi; `~` is the scene home. */
	env?: Record<string, string>;
	/** Start a shell instead of pi, with `pi` on its PATH loading the same extensions. */
	shell?: boolean;
}

/** Demo accounts: each provider authenticates with its own environment key, so its Account source is `env:<VAR>`. */
export const ACCOUNTS: Record<string, { key: string; models: string[] }> = {
	acme: { key: "ACME_WORK_KEY", models: ["work-model"] },
	homelab: { key: "HOMELAB_KEY", models: ["home-model", "home-model-large"] },
	spare: { key: "SPARE_KEY", models: ["spare-model"] },
};

export const CONFIG = {
	zones: ["work", "personal"],
	defaultZone: "personal",
	accounts: [
		{ provider: "acme", source: "env:ACME_WORK_KEY", zones: ["work"], note: "Acme seat" },
		{ provider: "homelab", source: "env:HOMELAB_KEY", zones: ["personal"] },
	],
	places: [
		{ remote: "*/acme-corp/*", zone: "work" },
		{ path: "~/work", zone: "work" },
	],
};

const providerExtension = (llmUrl: string, bridge: boolean) => `// Demo accounts for the recording; every request goes to the scene's fake provider.
const ACCOUNTS = ${JSON.stringify(ACCOUNTS)};
export default function demoAccounts(pi) {
	// The guard keys claude-bridge handling on the provider id; this stand-in has only that id, not the bridge.
	if (${bridge}) pi.registerProvider("claude-bridge", { name: "claude-bridge (stand-in)", baseUrl: "${llmUrl}/claude-bridge/v1", apiKey: "stand-in", api: "openai-completions", models: [{ type: "chat", id: "bridge-model", name: "bridge-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }] });
	for (const [name, { key, models }] of Object.entries(ACCOUNTS)) {
		pi.registerProvider(name, {
			name, baseUrl: "${llmUrl}/" + name + "/v1", apiKey: "$" + key, api: "openai-completions",
			models: models.map((id) => ({ type: "chat", id, name: id, reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 })),
		});
	}
}
`;

const SWITCHBOARD = {
	profiles: {
		home: {
			tiers: { light: { rank: 1, members: ["homelab/home-model"] }, deep: { rank: 2, members: ["homelab/home-model-large"] } },
			fallbackTier: "light",
		},
	},
	profileSelection: { default: "home" },
};

export const REPOSITORIES = {
	work: { path: "work/acme-api", remote: "git@github.com:acme-corp/acme-api.git", file: "src/server.ts" },
	personal: { path: "personal/garden-planner", remote: "git@github.com:homelab-dev/garden-planner.git", file: "src/beds.ts" },
	// A client repository outside the work organization: no rule matches it until one is added.
	client: { path: "projects/billing-portal", remote: "git@github.com:northwind-labs/billing-portal.git", file: "src/invoice.ts" },
};

export default async function setup(item: { scene: string; variant?: string }) {
	const packageDir = process.env.MEDIA_PACKAGE;
	if (!packageDir) throw new Error("setup: MEDIA_PACKAGE is not set; run through scripts/tools/media.ts");
	const repo = join(packageDir, "..", "..");
	const module = (await import(pathToFileURL(join(import.meta.dirname, "scenes", `${item.scene}.ts`)).href)) as Record<string, GuardScene>;
	const scene = module[item.variant ?? "scene"];
	if (!scene) throw new Error(`setup: scene ${item.scene} has no export ${item.variant ?? "scene"}`);
	const llm = await startLlm(scene.llm);
	const home = createSceneHome(scene.settings ?? {});
	home.write(".pi/agent/extensions/demo-accounts.js", providerExtension(llm.url, scene.bridge === true));
	if (scene.config !== false) home.write(".pi/agent/account-guard.json", `${JSON.stringify(scene.config ?? CONFIG, null, 2)}\n`);
	if (scene.with?.includes("switchboard")) home.write(".pi/agent/pi-switchboard.json", `${JSON.stringify(SWITCHBOARD, null, "\t")}\n`);
	for (const { path, remote, file } of Object.values(REPOSITORIES)) {
		const dir = join(home.home, path);
		home.write(`${path}/${file}`, "export const ready = true;\n");
		for (const args of [
			["init", "-q"],
			["remote", "add", "origin", remote],
		])
			spawnSync("git", args, { cwd: dir });
	}
	const extensions = [join(packageDir, "src", "index.ts")];
	if (scene.with?.includes("switchboard")) extensions.push(join(repo, "packages", "pi-switchboard", "src", "index.ts"));
	if (scene.with?.includes("powerline")) extensions.push(join(repo, "node_modules", "pi-powerline-footer", "index.ts"));
	const pi = piCommand(
		repo,
		extensions.flatMap((path) => ["-e", path]),
	);
	if (scene.shell) home.write("bin/pi", `#!/bin/sh\nexec ${[pi.command, ...pi.args].map((word) => `'${word}'`).join(" ")} "$@"\n`, 0o755);
	return {
		spawn: {
			...(scene.shell ? { command: "bash", args: ["--noprofile", "--norc", "-i"] } : { command: pi.command, args: [...pi.args, "--model", scene.model] }),
			cwd: join(home.home, REPOSITORIES[scene.place].path),
			env: {
				HOME: home.home,
				...(scene.shell ? { PATH: `${join(home.home, "bin")}:/usr/local/bin:/usr/bin:/bin`, PS1: "\\w $ ", HISTFILE: "/dev/null" } : {}),
				PI_CODING_AGENT_DIR: home.agentDir,
				PI_OFFLINE: "1",
				...Object.fromEntries(Object.values(ACCOUNTS).map(({ key }) => [key, "demo-not-a-secret"])),
				...Object.fromEntries(Object.entries(scene.env ?? {}).map(([name, value]) => [name, value.replace(/^~/, home.home)])),
			},
		},
		async close() {
			// MEDIA_KEEP=<folder> (relative to media/) keeps the scene's home.
			home.close(item.variant ?? item.scene, join(import.meta.dirname, ".."));
			llm.server.close();
		},
	};
}
