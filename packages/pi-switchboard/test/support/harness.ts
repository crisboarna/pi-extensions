// Boots the extension against the fake pi host in an isolated agent directory.
// Shared by the integration tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession, type routeRequest, type Scenario } from "./fake-pi.ts";

export const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

export const BASE_CONFIG = {
	classifierProviders: [{ name: "local", baseUrl: "http://127.0.0.1:1234/v1/", models: ["judge"] }],
	classifiers: [{ model: "local/judge", timeoutMs: 1000, threshold: 0.8, warmup: false }],
	profiles: {
		work: {
			tiers: {
				light: { rank: 1, members: ["acme/small:low"] },
				standard: { rank: 2, members: ["acme/mid", "zen/mid"], strategy: "ordered" },
				deep: { rank: 3, members: ["acme/big:high"] },
			},
			fallbackTier: "standard",
		},
	},
	profileSelection: { default: "work" },
	subagents: { agents: { scout: { maxTier: "standard" } } },
	state: { shared: false },
};

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_SWITCHBOARD_CONFIG", "PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	delete (globalThis as { __switchboardTest?: unknown }).__switchboardTest;
});

export interface BootOptions {
	config?: Record<string, unknown>;
	/** Install a stand-in for pi-subagents (required child extensions and launch preflight). */
	subagents?: Record<string, never>;
	scenario?: Scenario;
	header?: { parentSession?: string };
	env?: Record<string, string>;
	cwd?: string;
}

/** Loads the extension through jiti (as pi does), against fakes, in an isolated agent directory. */
export async function boot(options: BootOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "switchboard-integration-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(dir, "pi-switchboard.json");
	writeFileSync(configPath, JSON.stringify({ ...BASE_CONFIG, ...options.config }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SWITCHBOARD_CONFIG = configPath;
	for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;

	if (options.subagents) {
		const root = join(agentDir, "npm", "node_modules", "pi-subagents");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		mkdirSync(root, { recursive: true });
		writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: scans\n---\nbody\n");
		writeFileSync(join(agentDir, "agents", "codex-exec.md"), "---\nname: codex-exec\nrunner:\n  type: external-cli\n  command: codex\n---\nbody\n");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "pi-subagents",
				version: "0.0.0-test",
				type: "module",
				exports: { "./required-child-extensions": { default: "./rce.js" }, "./preflight": { default: "./preflight.js" } },
			}),
		);
		writeFileSync(
			join(root, "rce.js"),
			"export function registerRequiredChildExtensions(input) { const t = (globalThis.__switchboardTest ??= {}); t.registered = input; return { dispose() { t.disposed = true; } }; }\n",
		);
		writeFileSync(
			join(root, "preflight.js"),
			`export async function resolveSubagentLaunchContract(input) { const file = input.agent === "codex-exec" ? ${JSON.stringify(join(agentDir, "agents", "codex-exec.md"))} : ${JSON.stringify(join(agentDir, "agents", "scout.md"))}; return { ok: true, contract: { tools: { effectiveAllowlist: ["read", "grep"] }, agent: { filePath: file } } }; }\n`,
		);
	}

	const host = createFakeHost();
	const session = createFakeSession(host, { scenario: options.scenario ?? "implement", ...(options.cwd ? { cwd: options.cwd } : {}) });
	if (options.header) session.setHeader(options.header);
	const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
	// pi loads extensions through jiti, so that is the default. The coverage run imports natively instead:
	// V8 coverage cannot map code that jiti transforms back to the source files.
	const module = (process.env.SWITCHBOARD_NATIVE_IMPORT === "1" ? await import(INDEX) : await jiti.import(INDEX)) as { default: (pi: unknown) => void };
	module.default(host.pi);
	await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
	const route = (request: ReturnType<typeof routeRequest>) => {
		const virtual = host.virtualModels.get(request.model.id);
		assert.ok(virtual, `virtual model ${request.model.id} is registered`);
		return virtual.route(request, session.ctx);
	};
	const decisions = () => host.entries.filter((e) => e.customType === "pi-switchboard.decision").map((e) => e.data);
	const tier = (args: string) => host.commands.get("tier")?.handler(args, session.ctx);
	return { dir, agentDir, host, session, route, decisions, tier };
}
