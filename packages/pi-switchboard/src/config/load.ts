import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeConfig } from "./normalize.ts";
import type { CatalogView, Config, ProfileConfig, RawConfig } from "./types.ts";

export const CONFIG_FILE = "pi-switchboard.json";
export const DATA_DIR = "pi-switchboard";

/** The user config file; `PI_SWITCHBOARD_CONFIG` points elsewhere (tests, trying an example). */
export function userConfigPath(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SWITCHBOARD_CONFIG || join(agentDir, CONFIG_FILE);
}

export function dataDir(agentDir: string): string {
	return join(agentDir, DATA_DIR);
}

/** The nearest `.pi/pi-switchboard.json` from `cwd` upward, stopping below the home directory. */
export function findProjectConfig(cwd: string, home: string = homedir()): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (dir === home) return undefined;
		const candidate = join(dir, ".pi", CONFIG_FILE);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function readJson(path: string): { value?: RawConfig; error?: string } {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: `${path}: the top level must be an object` };
		return { value: value as RawConfig };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Keys a project file may set; everything else (classifiers, evidence, debug, state) stays user-only. */
const PROJECT_KEYS = new Set(["$schema", "version", "profile", "profiles", "rulesets", "profileSelection", "subagents"]);

/**
 * Applies a project file on top of the user file. Projects can add or adjust
 * profiles (tiers replace per tier), add rulesets, prepend selection rules,
 * choose their profile and set per-agent tier limits. Never classifiers.
 */
export function mergeProject(user: RawConfig, project: RawConfig, source: string): { merged: RawConfig; warnings: string[] } {
	const warnings: string[] = [];
	for (const key of Object.keys(project)) {
		if (!PROJECT_KEYS.has(key)) warnings.push(`${source}: "${key}" is ignored in a project file`);
	}
	const merged: RawConfig = { ...user };
	if (project.profile) merged.profile = project.profile;
	if (project.rulesets) merged.rulesets = { ...user.rulesets, ...project.rulesets };
	if (project.profiles) {
		const profiles: Record<string, ProfileConfig> = { ...user.profiles };
		for (const [name, override] of Object.entries(project.profiles)) {
			const base = profiles[name];
			profiles[name] = base ? { ...base, ...override, tiers: { ...base.tiers, ...override.tiers } } : override;
		}
		merged.profiles = profiles;
	}
	if (project.profileSelection) {
		merged.profileSelection = {
			...user.profileSelection,
			...(project.profileSelection.default ? { default: project.profileSelection.default } : {}),
			rules: [...(project.profileSelection.rules ?? []), ...(user.profileSelection?.rules ?? [])],
		};
	}
	if (project.subagents) {
		const extra = Object.keys(project.subagents).filter((key) => key !== "agents");
		if (extra.length) warnings.push(`${source}: only subagents.agents can be set in a project file (ignored: ${extra.join(", ")})`);
		if (project.subagents.agents) merged.subagents = { ...user.subagents, agents: { ...user.subagents?.agents, ...project.subagents.agents } };
	}
	return { merged, warnings };
}

export interface LoadOptions {
	agentDir: string;
	cwd: string;
	/** pi's project trust; untrusted projects never contribute config. */
	projectTrusted: boolean;
	catalog?: CatalogView;
	home?: string;
}

export interface Loaded {
	config: Config;
	/** True when neither file exists. */
	missing: boolean;
	userPath: string;
	projectPath?: string;
}

export function loadConfig(options: LoadOptions): Loaded {
	const userPath = userConfigPath(options.agentDir);
	const warnings: string[] = [];
	const sources: string[] = [];
	const user = readJson(userPath);
	if (user.error) warnings.push(user.error);
	if (user.value) sources.push(userPath);
	let raw: RawConfig = user.value ?? {};

	const projectPath = findProjectConfig(options.cwd, options.home);
	if (projectPath) {
		if (!options.projectTrusted) {
			warnings.push(`${projectPath}: ignored because this project is not trusted`);
		} else {
			const project = readJson(projectPath);
			if (project.error) warnings.push(project.error);
			if (project.value) {
				const { merged, warnings: mergeWarnings } = mergeProject(raw, project.value, projectPath);
				raw = merged;
				warnings.push(...mergeWarnings);
				sources.push(projectPath);
			}
		}
	}
	const config = normalizeConfig(raw, { warnings, sources, ...(options.catalog ? { catalog: options.catalog } : {}) });
	return { config, missing: sources.length === 0, userPath, ...(projectPath ? { projectPath } : {}) };
}
