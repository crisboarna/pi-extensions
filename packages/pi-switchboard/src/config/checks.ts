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
	/** Whether the classifier model exists in pi's registry as a classifier with credentials. */
	classifierAvailable: (model: string) => boolean;
	classifierIsLocal: (model: string) => boolean;
	read?: Reader;
}

/** The warning shown once when several accounts of one provider are used together. */
export const TOS_WARNING =
	"pooling several subscription accounts of one provider to get around its rate limits may breach that provider's terms; rotating between different providers or models does not";

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
		if (!input.classifierAvailable(entry.model)) {
			warnings.push(
				`classifier ${entry.model} is not registered as a classifier or has no credentials; check classifierProviders and /login. Its decisions fall back to the fallback tier.`,
			);
		} else if (!input.classifierIsLocal(entry.model) && !entry.allowRemote) {
			warnings.push(`classifier ${entry.model} runs off this machine and is skipped; set "allowRemote": true to let it receive request text.`);
		}
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
