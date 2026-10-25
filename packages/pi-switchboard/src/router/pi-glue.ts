import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TranscriptMessage, PlanPhase } from "../classifier/evidence.ts";
import { textOf } from "../classifier/evidence.ts";
import type { CatalogView, Config } from "../config/types.ts";
import type { EngineCatalog } from "./engine.ts";

/** The parts of pi's model registry the router reads. */
export interface RegistryLike {
	find(provider: string, id: string): { provider: string; id: string; contextWindow?: number; cost?: { input?: number; output?: number } } | undefined;
	getAll(): Array<{ provider: string; id: string }>;
	getProvider(name: string): unknown;
	getProviderAuthStatus(provider: string): { configured: boolean };
	isUsingOAuth(model: never): boolean;
}

/** Blended price per million tokens, input and output weighted 3:1. */
export function blendedPrice(cost: { input?: number; output?: number } | undefined): number | undefined {
	if (!cost || (cost.input === undefined && cost.output === undefined)) return undefined;
	return ((cost.input ?? 0) * 3 + (cost.output ?? 0)) / 4;
}

export function engineCatalog(registry: RegistryLike): EngineCatalog {
	const oauth = new Map<string, boolean>();
	return {
		find(provider, id) {
			const model = registry.find(provider, id);
			if (!model) return undefined;
			const price = blendedPrice(model.cost);
			return { ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(price !== undefined ? { price } : {}) };
		},
		hasAuth: (provider) => registry.getProviderAuthStatus(provider).configured,
		isProvider: (name) => registry.getProvider(name) !== undefined,
		subscription(provider) {
			if (!oauth.has(provider)) {
				const model = registry.getAll().find((m) => m.provider === provider);
				oauth.set(provider, model ? registry.isUsingOAuth(model as never) : false);
			}
			return oauth.get(provider) ?? false;
		},
	};
}

export function catalogView(registry: RegistryLike): CatalogView {
	return {
		find: (provider, id) => {
			const model = registry.find(provider, id);
			return model ? { ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}) } : undefined;
		},
		hasAuth: (provider) => registry.getProviderAuthStatus(provider).configured,
		isProvider: (name) => registry.getProvider(name) !== undefined,
	};
}

/** Plannotator's request channel and its plan-mode status request. */
const PLANNOTATOR_CHANNEL = "plannotator:request";

export interface EventsLike {
	emit(channel: string, data: unknown): void;
}

/** Asks Plannotator for its phase; `unknown` when it does not answer in time. */
export function queryPlanPhase(events: EventsLike, timeoutMs = 100): Promise<PlanPhase> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (phase: PlanPhase) => {
			if (settled) return;
			settled = true;
			resolve(phase);
		};
		const timer = setTimeout(() => finish("unknown"), timeoutMs);
		timer.unref?.();
		try {
			events.emit(PLANNOTATOR_CHANNEL, {
				requestId: `switchboard-${Date.now()}`,
				action: "plan-mode",
				payload: { mode: "status" },
				respond: (response: { status?: string; result?: { phase?: string } }) => {
					clearTimeout(timer);
					const phase = response?.status === "handled" ? response.result?.phase : undefined;
					finish(phase === "planning" || phase === "executing" || phase === "idle" ? phase : "unknown");
				},
			});
		} catch {
			clearTimeout(timer);
			finish("unknown");
		}
	});
}

const ACTIVE_AGENT = /<active_agent name="([^"]+)"\s*\/>/u;

/** The subagent name pi-subagents puts in a child's system prompt. */
export function agentFromMessages(messages: readonly TranscriptMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role !== "system") continue;
		const match = ACTIVE_AGENT.exec(textOf(message.content));
		if (match?.[1]) return match[1];
	}
	return undefined;
}

export function estimateTokens(messages: readonly unknown[]): number {
	try {
		return Math.ceil(JSON.stringify(messages).length / 4);
	} catch {
		return 0;
	}
}

/** Virtual model ids for a config: `auto`, each valid profile, and each profile's tiers. */
export function virtualModelIds(config: Config): Array<{ id: string; name: string }> {
	const ids = [{ id: config.virtualModel.id, name: config.virtualModel.name }];
	for (const profile of Object.values(config.profiles)) {
		ids.push({ id: profile.name, name: `${config.virtualModel.name}: ${profile.name}` });
		for (const tier of profile.tiers) ids.push({ id: `${profile.name}.${tier.name}`, name: `${config.virtualModel.name}: ${profile.name} · ${tier.name}` });
	}
	return ids;
}

/** Extension-owned runtime state: the global manual profile and one-time warnings. */
export interface SwitchboardState {
	globalProfile?: string;
	warned?: { tos?: boolean };
}

export class StateFile {
	private readonly path: string;

	constructor(dir: string) {
		this.path = join(dir, "state.json");
	}

	read(): SwitchboardState {
		try {
			return JSON.parse(readFileSync(this.path, "utf8")) as SwitchboardState;
		} catch {
			return {};
		}
	}

	write(update: (state: SwitchboardState) => SwitchboardState): void {
		const next = update(this.read());
		mkdirSync(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, this.path);
	}
}

/** Whether another main-session router that conflicts with this one is installed. */
export function conflictingRouter(agentDir: string): string | undefined {
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
		for (const entry of settings.packages ?? []) {
			const source = typeof entry === "string" ? entry : (entry as { source?: string })?.source;
			if (typeof source === "string" && source.includes("@alexeiled/pi-model-router")) return "@alexeiled/pi-model-router";
		}
	} catch {
		// No settings file.
	}
	return undefined;
}
