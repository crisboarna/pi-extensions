// Where an end-to-end suite keeps its files, which model servers were asked
// for, and an environment that keeps pi and the CLI away from the user's own
// state. Every suite starts from `startRun(<suite>)`.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PACKAGE = resolve(import.meta.dirname, "..", "..", "..");
export const REPO = resolve(PACKAGE, "..", "..");
/** The clone's git folder (shared by worktrees), which holds caches and run folders outside the tracked tree. */
const GIT_DIR = resolve(REPO, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: REPO, encoding: "utf8" }).trim());

const SERVERS = ["ollama", "llamacpp", "llamacpp-chat", "litellm", "lmstudio"] as const;
export type ServerSuite = (typeof SERVERS)[number];
/** `E2E_SERVERS=docker` selects every route that runs in Docker; LM Studio runs natively and only when named. */
const DOCKER: readonly ServerSuite[] = ["ollama", "llamacpp", "llamacpp-chat", "litellm"];

/** The model-server suites `E2E_SERVERS` asks for; an unknown name is an error, not a silent skip. */
function selectedServers(): Set<ServerSuite> {
	const names = (process.env.E2E_SERVERS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const picked = new Set<ServerSuite>();
	for (const name of names) {
		if (name === "docker") for (const server of DOCKER) picked.add(server);
		else if ((SERVERS as readonly string[]).includes(name)) picked.add(name as ServerSuite);
		else throw new Error(`E2E_SERVERS: unknown suite "${name}"; use docker or any of ${SERVERS.join(", ")}`);
	}
	return picked;
}

/** The `skip` option for a model-server suite: false when `E2E_SERVERS` selects it. */
export function skipUnlessSelected(suite: ServerSuite): string | false {
	return selectedServers().has(suite) ? false : `set E2E_SERVERS=${suite} (or docker) to run it`;
}

/** Downloads kept between runs (models, npm tarballs), so a rerun uses the same files; `E2E_FRESH=1` starts empty. */
export function cacheDir(name: string): string {
	const root = process.env.E2E_FRESH === "1" ? join(GIT_DIR, "e2e-runs", "fresh-cache") : join(GIT_DIR, "e2e-cache");
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	return path;
}

export interface Run {
	/** This suite's folder: logs, agent folders, the installed tarball and results.json. */
	dir: string;
	/** A subfolder of `dir`, created empty. */
	folder(name: string): string;
	/** Records a measured value in results.json, for comparing runs. */
	record(key: string, value: unknown): void;
	/** `message` plus where to look, for assertion messages. */
	explain(message: string): string;
}

/** Starts a suite's run folder, `<git>/e2e-runs/<suite>/`, emptied first so it holds only this run. */
export function startRun(suite: string): Run {
	const dir = join(GIT_DIR, "e2e-runs", suite);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const results: Record<string, unknown> = {};
	return {
		dir,
		folder(name) {
			const path = join(dir, name);
			rmSync(path, { recursive: true, force: true });
			mkdirSync(path, { recursive: true });
			return path;
		},
		record(key, value) {
			results[key] = value;
			writeFileSync(join(dir, "results.json"), `${JSON.stringify(results, null, "\t")}\n`);
		},
		explain: (message) => `${message}\n(logs: ${dir})`,
	};
}

/**
 * Credentials and the settings pi, the CLI, npm and the servers' own commands
 * read, none of which may leak in from the user's shell; `npm run` adds
 * `npm_config_*` (such as the workspace) for its scripts.
 */
const INHERITED = /API_KEY|TOKEN|SECRET|CREDENTIALS|AUTH|^PI_|^LLAMA_|^OLLAMA_|^LITELLM_|^HF_|^XDG_|^E2E_|^NPM_|^NODE_OPTIONS$/iu;

/** The user's environment without credentials or pi settings, with `HOME` in the run folder, plus `extra`. */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !INHERITED.test(key)) env[key] = value;
	return { ...env, HOME: home, ...extra };
}

/** Polls `check` every 250 ms until it is true, or fails after `timeoutMs` saying what it waited for. */
export async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 250));
	}
}
