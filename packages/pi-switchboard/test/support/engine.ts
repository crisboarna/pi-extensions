// An engine with injected clock, health store, catalog and classifier, shared by the engine tests.
import type { ClassifyFn } from "../../src/classifier/chain.ts";
import type { TranscriptMessage } from "../../src/classifier/evidence.ts";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";
import { type EngineDeps, type RouteInput, SwitchboardEngine } from "../../src/router/engine.ts";
import type { Answers } from "../../src/rules/types.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { seededRng } from "../../src/util/runtime.ts";

export const RAW: RawConfig = {
	classifiers: [{ model: "local/judge", timeoutMs: 500, threshold: 0.8 }],
	profiles: {
		main: {
			tiers: {
				light: { rank: 1, members: ["acme/small:low"] },
				standard: { rank: 2, members: ["acme/mid", "zen/mid:medium"], strategy: "ordered" },
				deep: { rank: 3, members: ["acme/big:high"] },
			},
			fallbackTier: "standard",
			baselineTier: "light",
		},
		other: { tiers: { only: { rank: 1, members: ["zen/one"] } } },
	},
	profileSelection: { default: "main", rules: [{ matchProvider: "zen*", profile: "other" }] },
	subagents: { agents: { scout: { maxTier: "standard" } } },
};

const WINDOWS: Record<string, number> = {
	"acme/small": 32_000,
	"acme/mid": 128_000,
	"zen/mid": 128_000,
	"acme/big": 400_000,
	"zen/one": 64_000,
	"acme-2/mid": 128_000,
};

export function answers(work: string, workConfidence = 0.95, depth = 1, risky = 0.1): Answers {
	return {
		work: { type: "choice", choice: work, probabilities: {}, confidence: workConfidence },
		depth: { type: "score", score: depth, confidence: 0.4 },
		risky: { type: "bool", probability: risky },
	};
}

export function engine(options: { classify?: ClassifyFn; raw?: RawConfig; now?: () => number; deps?: Partial<EngineDeps> } = {}) {
	const config = normalizeConfig(options.raw ?? RAW);
	let now = Date.UTC(2026, 9, 25, 12);
	const deps: EngineDeps = {
		config,
		missingConfig: false,
		catalog: {
			find: (provider, id) => {
				const contextWindow = WINDOWS[`${provider}/${id}`];
				return contextWindow ? { contextWindow } : undefined;
			},
			hasAuth: () => true,
			isProvider: (name) => ["acme", "acme-2", "zen"].includes(name),
			subscription: () => true,
		},
		store: new MemoryHealthStore(),
		classify: options.classify ?? (async () => ({ stopReason: "stop", answers: answers("implement") })),
		clock: { now: options.now ?? (() => now) },
		rng: seededRng(3),
		cwd: "/work/repo",
		home: "/home/dev",
		planPhase: async () => "executing",
		globalProfile: () => undefined,
		subscriptions: () => [{ provider: "acme", index: 2 }],
		...options.deps,
	};
	const e = new SwitchboardEngine(deps);
	return { e, deps, advance: (ms: number) => (now += ms) };
}

export const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
export const toolError = (tool: string): TranscriptMessage => ({
	role: "toolResult",
	toolName: tool,
	isError: true,
	content: [{ type: "text", text: "failed" }],
});

export function input(extra: Partial<RouteInput> = {}): RouteInput {
	return { virtualId: "auto", selectedThinking: "medium", reason: "user", messages: [user("do the thing")], scope: "main", ...extra };
}
