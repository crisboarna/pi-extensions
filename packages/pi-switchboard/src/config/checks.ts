import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";

type Reader = (path: string) => string | undefined;

const readText: Reader = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

function readJsonObject(read: Reader, path: string): Record<string, unknown> | undefined {
	const text = read(path);
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function modelOf(node: unknown): { provider: string; id: string } | null | undefined {
	if (node === undefined) return undefined;
	if (node === null || node === "") return null;
	if (typeof node === "object" && node !== null) {
		const { provider, id } = node as { provider?: unknown; id?: unknown };
		if (typeof provider === "string" && typeof id === "string") return { provider, id };
	}
	return undefined;
}

export interface PlannotatorModel {
	where: string;
	model: string;
	/** The file whose layer last set it. */
	file: string;
}

/**
 * Per-phase models Plannotator would apply. Its config has three layers
 * (built in, `~/.pi/agent/plannotator.json`, `<cwd>/.pi/plannotator.json`);
 * a later layer overrides an earlier one, and `null` clears an inherited value.
 */
export function plannotatorModels(layers: ReadonlyArray<{ file: string; json: Record<string, unknown> }>): PlannotatorModel[] {
	const fields: Array<[string, (json: Record<string, unknown>) => unknown]> = [
		["defaults", (json) => (json.defaults as { model?: unknown } | undefined)?.model],
		["planning", (json) => (json.phases as Record<string, { model?: unknown }> | undefined)?.planning?.model],
		["executing", (json) => (json.phases as Record<string, { model?: unknown }> | undefined)?.executing?.model],
	];
	const out: PlannotatorModel[] = [];
	for (const [where, pick] of fields) {
		let current: { provider: string; id: string } | null | undefined;
		let file = "";
		for (const layer of layers) {
			const value = modelOf(pick(layer.json));
			if (value !== undefined) {
				current = value;
				file = layer.file;
			}
		}
		if (current) out.push({ where, model: `${current.provider}/${current.id}`, file });
	}
	return out;
}

export interface ChecksInput {
	config: Config;
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	/** Plannotator's built-in config, if installed. */
	plannotatorBuiltin?: string;
	/** Whether pi's registry lists the model as a classifier; credentials play no part. */
	classifierAvailable: (model: string) => boolean;
	/** Why pi does not list it, for the warning's hint. */
	classifierCause: (model: string) => UnlistedCause;
	classifierIsLocal: (model: string) => boolean;
	read?: Reader;
}

/** The warning shown once when several accounts of one provider are used together. */
export const TOS_WARNING =
	"pooling several subscription accounts of one provider to get around its rate limits may breach that provider's terms; rotating between different providers or models does not";

/** Why pi does not list a classifier, which decides what its warning tells the user to check. */
export type UnlistedCause = "pi-provider" | "classifier-provider" | "unknown";

/**
 * The cause, found as `/tier doctor` finds it: a classifierProviders entry of that name, which pi-switchboard
 * registered, so the entry lacks the model; else one of pi's own providers, which may list a server's models late.
 */
export function unlistedCause(model: string, entries: ReadonlyArray<{ name: string }>, piHas: (provider: string) => boolean): UnlistedCause {
	const provider = model.slice(0, Math.max(model.indexOf("/"), 0));
	if (!provider) return "unknown";
	if (entries.some((entry) => entry.name === provider)) return "classifier-provider";
	return piHas(provider) ? "pi-provider" : "unknown";
}

/** The warning for a classifier pi does not list; `/tier doctor` says it in its own words, so it leaves this one out. */
export function unregisteredWarning(model: string, cause: UnlistedCause): string {
	const slash = model.indexOf("/");
	const provider = model.slice(0, Math.max(slash, 0));
	const why =
		cause === "pi-provider"
			? `is not listed by pi's ${provider} provider: is its server running with the model loaded?`
			: cause === "classifier-provider"
				? `is not listed by its classifierProviders entry ${provider}: add ${model.slice(slash + 1)} to the entry's "models".`
				: provider
					? `names ${provider}, a provider pi does not have: add a classifierProviders entry for it.`
					: "names no provider: write it as provider/model.";
	return `classifier ${model} ${why} Its decisions fall back to the fallback tier.`;
}

/** The warning for a remote classifier without allowRemote; `/tier doctor` says it in its own words, so it leaves this one out. */
export const remoteSkippedWarning = (model: string) =>
	`classifier ${model} runs off this machine and is skipped; set "allowRemote": true to let it receive request text.`;

/** Warnings about the environment around the config; shown at session start and by `/tier validate`. */
export function runChecks(input: ChecksInput): string[] {
	const read = input.read ?? readText;
	const warnings: string[] = [];
	const { config } = input;

	// Plannotator switching models per phase would pull the session off the virtual model.
	const candidates = [
		...(input.plannotatorBuiltin ? [input.plannotatorBuiltin] : []),
		join(input.agentDir, "plannotator.json"),
		...(input.projectTrusted ? [join(input.cwd, ".pi", "plannotator.json")] : []),
	];
	const layers = candidates.flatMap((file) => {
		const json = readJsonObject(read, file);
		return json ? [{ file, json }] : [];
	});
	for (const set of plannotatorModels(layers)) {
		warnings.push(
			`Plannotator sets ${set.model} for ${set.where} in ${set.file}; entering or leaving plan mode would switch the model away from ${config.virtualModel.provider}. Set that model to null.`,
		);
	}

	// multi-pass restricts a project to listed providers and switches away from any other.
	const multiPassPath = join(input.cwd, ".pi", "multi-pass.json");
	const multiPass = readJsonObject(read, multiPassPath);
	const allowed = Array.isArray(multiPass?.allowedSubs)
		? (multiPass.allowedSubs as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "")
		: [];
	if (allowed.length > 0 && !allowed.map((v) => v.trim()).includes(config.virtualModel.provider)) {
		warnings.push(
			`${multiPassPath} restricts this project with allowedSubs; pi-multi-pass will switch away from ${config.virtualModel.provider}/*. Add "${config.virtualModel.provider}" to allowedSubs.`,
		);
	}

	for (const entry of config.classifiers) {
		if (!input.classifierAvailable(entry.model)) warnings.push(unregisteredWarning(entry.model, input.classifierCause(entry.model)));
		else if (!input.classifierIsLocal(entry.model) && !entry.allowRemote) warnings.push(remoteSkippedWarning(entry.model));
	}
	return warnings;
}

/** Whether the config pools accounts, so the one-time terms-of-service notice applies. */
export function needsTosNotice(config: Config): boolean {
	return config.failover.accountSiblings === "on" || config.warnings.some((warning) => warning.includes("may breach the provider's terms"));
}

/** Config warnings without the terms-of-service lines, which go through the one-time notice. */
export function withoutTosWarnings(warnings: readonly string[]): string[] {
	return warnings.filter((warning) => !warning.includes("may breach the provider's terms"));
}
