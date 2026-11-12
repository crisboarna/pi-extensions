import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PinInfo, PinLookup } from "./launch.ts";

/** Why subagents are not routed when pi-subagents is absent; `/tier doctor` tells it apart from real problems. */
export const PI_SUBAGENTS_MISSING = "pi-subagents is not installed";

/** What decides where pi installed pi-subagents. */
export interface SubagentsLookup {
	agentDir: string;
	cwd: string;
	/** pi installs and loads project packages only in a trusted project. */
	projectTrusted: boolean;
}

/**
 * Where pi installs pi-subagents from npm, in the order this looks: the project's `.pi/npm` when the project is trusted, then the agent
 * directory's `npm`. pi's legacy global npm root and git installs are not looked in: finding them means running npm.
 */
export function subagentsPaths({ agentDir, cwd, projectTrusted }: SubagentsLookup): string[] {
	const user = join(agentDir, "npm", "node_modules", "pi-subagents");
	return projectTrusted ? [join(cwd, ".pi", "npm", "node_modules", "pi-subagents"), user] : [user];
}

/** pi-subagents' package root, if it is installed in one of `subagentsPaths`. */
export function subagentsRoot(lookup: SubagentsLookup): string | undefined {
	return subagentsPaths(lookup).find((root) => existsSync(join(root, "package.json")));
}

async function importExport(root: string, name: string): Promise<Record<string, unknown> | undefined> {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			exports?: Record<string, { default?: string; import?: string } | string>;
		};
		const entry = pkg.exports?.[`./${name}`];
		const file = typeof entry === "string" ? entry : (entry?.default ?? entry?.import);
		if (!file) return undefined;
		return (await import(pathToFileURL(join(root, file)).href)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export interface RequiredRegistration {
	dispose(): void;
}

/**
 * Loads pi-switchboard into every native child of this session through
 * pi-subagents' required child extensions (ADR-0001). Returns undefined with a
 * reason when that is not possible, so launches fall back to physical models.
 */
export async function registerChildExtension(
	lookup: SubagentsLookup,
	sessionId: string,
	entryPath: string,
): Promise<{ registration?: RequiredRegistration; reason?: string; searched?: string[] }> {
	const root = subagentsRoot(lookup);
	if (!root) return { reason: PI_SUBAGENTS_MISSING, searched: subagentsPaths(lookup) };
	const api = await importExport(root, "required-child-extensions");
	const register = api?.registerRequiredChildExtensions;
	if (typeof register !== "function") return { reason: "this pi-subagents version has no required child extensions" };
	try {
		const registration = register({ sessionId, extensions: [{ id: "pi-switchboard", path: entryPath }] }) as RequiredRegistration;
		return { registration };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Whether an agent runs as a native pi child or through an external runner, from its frontmatter. */
export function runnerOf(filePath: string | undefined): "native" | "external" {
	if (!filePath) return "native";
	try {
		const text = readFileSync(filePath, "utf8");
		const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";
		const type = /^runner:\s*\n\s+type:\s*["']?([\w-]+)/mu.exec(frontmatter)?.[1] ?? /^runner:\s*["']?([\w-]+)/mu.exec(frontmatter)?.[1];
		return type && type !== "native" && type !== "pi" ? "external" : "native";
	} catch {
		return "native";
	}
}

/**
 * Asks pi-subagents' launch preflight which model an agent resolves to
 * without a model in the call; `unknown` when preflight is unavailable or
 * fails, so the caller treats the agent as pinned.
 */
export async function createPinLookup(agentDir: string, cwd: string, projectTrusted: boolean): Promise<PinLookup> {
	const root = subagentsRoot({ agentDir, cwd, projectTrusted });
	const api = root ? await importExport(root, "preflight") : undefined;
	const resolve = api?.resolveSubagentLaunchContract;
	if (typeof resolve !== "function") return async () => "unknown";
	return async (agent, task) => {
		try {
			const result = (await resolve({ agent, task, cwd, projectTrusted, context: "fresh" })) as {
				ok: boolean;
				contract?: { model?: string; tools?: { effectiveAllowlist?: string[] }; agent?: { filePath?: string } };
			};
			if (!result.ok || !result.contract) return "unknown";
			const tools = result.contract.tools?.effectiveAllowlist;
			const info: PinInfo = { runner: runnerOf(result.contract.agent?.filePath) };
			if (result.contract.model) info.model = result.contract.model;
			if (tools) info.tools = tools;
			return info;
		} catch {
			return "unknown";
		}
	};
}
