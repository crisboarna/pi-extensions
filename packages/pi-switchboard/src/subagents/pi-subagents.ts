import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PinLookup } from "./launch.ts";

/** pi-subagents' package root under pi's npm directory, if installed. */
export function subagentsRoot(agentDir: string): string | undefined {
	const root = join(agentDir, "npm", "node_modules", "pi-subagents");
	return existsSync(join(root, "package.json")) ? root : undefined;
}

async function importExport(root: string, name: string): Promise<Record<string, unknown> | undefined> {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports?: Record<string, { default?: string; import?: string } | string> };
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
export async function registerChildExtension(agentDir: string, sessionId: string, entryPath: string): Promise<{ registration?: RequiredRegistration; reason?: string }> {
	const root = subagentsRoot(agentDir);
	if (!root) return { reason: "pi-subagents is not installed" };
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

/**
 * Asks pi-subagents' launch preflight which model an agent resolves to
 * without a model in the call; `unknown` when preflight is unavailable or
 * fails, so the caller treats the agent as pinned.
 */
export async function createPinLookup(agentDir: string, cwd: string, projectTrusted: boolean): Promise<PinLookup> {
	const root = subagentsRoot(agentDir);
	const api = root ? await importExport(root, "preflight") : undefined;
	const resolve = api?.resolveSubagentLaunchContract;
	if (typeof resolve !== "function") return async () => "unknown";
	return async (agent, task) => {
		try {
			const result = (await resolve({ agent, task, cwd, projectTrusted, context: "fresh" })) as {
				ok: boolean;
				contract?: { model?: string; tools?: { effectiveAllowlist?: string[] } };
			};
			if (!result.ok || !result.contract) return "unknown";
			const tools = result.contract.tools?.effectiveAllowlist;
			return { ...(result.contract.model ? { model: result.contract.model } : {}), ...(tools ? { tools } : {}) };
		} catch {
			return "unknown";
		}
	};
}
