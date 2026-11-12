// Prepares a pi-account-guard terminal scene for tools/media/render.mjs: a
// throwaway home with a work and a personal repository, three accounts
// on the environment keys of OpenAI, Anthropic and Google, the guard's config, and a fake model provider whose
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
	/** pi-switchboard's config, when it is loaded; defaults to SWITCHBOARD. */
	switchboard?: Record<string, unknown>;
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
	openai: { key: "OPENAI_API_KEY", models: ["gpt-5.5"] },
	anthropic: { key: "ANTHROPIC_API_KEY", models: ["claude-sonnet-5", "claude-opus-5"] },
	google: { key: "GEMINI_API_KEY", models: ["gemini-3.8-flash"] },
};

export const CONFIG = {
	zones: ["work", "personal"],
	defaultZone: "personal",
	accounts: [
		{ provider: "openai", source: "env:OPENAI_API_KEY", zones: ["work"], note: "Company API key" },
		{ provider: "anthropic", source: "env:ANTHROPIC_API_KEY", zones: ["personal"] },
	],
	places: [
		{ remote: "*/my-company/*", zone: "work" },
		{ path: "~/work", zone: "work" },
	],
};

export const providerExtension = (llmUrl: string, bridge: boolean) => `// Demo accounts for the recording; every request goes to the scene's fake provider.
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
			tiers: { light: { rank: 1, members: ["anthropic/claude-sonnet-5"] }, deep: { rank: 2, members: ["anthropic/claude-opus-5"] } },
			fallbackTier: "light",
		},
	},
	profileSelection: { default: "home" },
};

/** pi-switchboard with a deep tier on the work account (openai), next to the personal anthropic tier. */
export const SWITCHBOARD_WITH_WORK_MEMBER = {
	profiles: {
		home: {
			tiers: { light: { rank: 1, members: ["anthropic/claude-sonnet-5"] }, deep: { rank: 2, members: ["openai/gpt-5.5"] } },
			fallbackTier: "light",
		},
	},
	profileSelection: { default: "home" },
};

export const REPOSITORIES = {
	work: { path: "work/payments-api", remote: "git@github.com:my-company/payments-api.git", file: "src/server.ts" },
	personal: { path: "code/dotfiles", remote: "git@github.com:me/dotfiles.git", file: "install.sh" },
	// A client repository outside the work organization: no rule matches it until one is added.
	client: { path: "projects/billing-portal", remote: "git@github.com:a-client/billing-portal.git", file: "src/invoice.ts" },
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
	if (scene.with?.includes("switchboard")) home.write(".pi/agent/pi-switchboard.json", `${JSON.stringify(scene.switchboard ?? SWITCHBOARD, null, "\t")}\n`);
	for (const { path, remote, file } of Object.values(REPOSITORIES)) {
		const dir = join(home.home, path);
		home.write(`${path}/${file}`, file.endsWith(".sh") ? '#!/bin/sh\nln -sf "$PWD/home/.zshrc" ~/.zshrc\n' : "export const ready = true;\n");
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
				// claude-bridge reads ANTHROPIC_API_KEY before its config directory, so a bridge scene starts without it unless the scene sets it.
				...Object.fromEntries(
					Object.values(ACCOUNTS)
						.filter(({ key }) => !(scene.bridge === true && key === "ANTHROPIC_API_KEY"))
						.map(({ key }) => [key, "demo-not-a-secret"]),
				),
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
