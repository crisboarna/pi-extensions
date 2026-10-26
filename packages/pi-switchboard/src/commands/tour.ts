import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { explain, summarize } from "../record/describe.ts";
import type { DecisionEntry } from "../record/types.ts";

/**
 * `/tier tour`: five short steps over sample decisions, so a new user sees
 * what pi-switchboard records and where to look, before routing anything.
 * The samples are built here; the tour writes nothing and changes no state.
 */
const SAMPLE_BASE: DecisionEntry = {
	v: 1,
	id: "d_tour_1",
	ts: "2026-01-01T09:00:00.000Z",
	task: 1,
	scope: "main",
	reason: "user",
	kind: "classified",
	profile: { name: "work", source: "default" },
	tier: { candidate: "light", chosen: "light", rank: 1, why: "rule 4 matched" },
	model: { provider: "provider-a", id: "small-model", thinking: "low" },
	switch: { cacheMiss: false },
};

const SMALL_JOB: DecisionEntry = {
	...SAMPLE_BASE,
	evidence: { digest: "tour", excerpt: "rename the variable foo to bar in utils.ts", tokens: 60, truncated: false },
	classifier: { model: "local/classifier", latencyMs: 310, attempts: [{ model: "local/classifier", ok: true, latencyMs: 310 }] },
	answers: {
		work: { type: "choice", choice: "mechanical", probabilities: { mechanical: 0.97 }, confidence: 0.96 },
		depth: { type: "score", score: 0.3, confidence: 0.8 },
		risky: { type: "bool", probability: 0.04 },
	},
	rules: { ruleset: "builtin", matched: 3, gate: { referenced: ["work"], confidence: 0.96, threshold: 0.85, passed: true }, floors: [] },
	selection: {
		strategy: "ordered",
		granularity: "session",
		why: "first healthy member in list order",
		kept: false,
		shared: true,
		candidates: [{ member: "provider-a/small-model:low", eligible: true }],
	},
};

const FAILOVER: DecisionEntry = {
	...SAMPLE_BASE,
	id: "d_tour_2",
	task: 2,
	reason: "retry",
	kind: "failover",
	tier: { candidate: "standard", chosen: "standard", rank: 2, why: "usage limit; benched until 14:00" },
	selection: {
		strategy: "ordered",
		granularity: "session",
		why: "first healthy member in list order",
		kept: false,
		shared: true,
		candidates: [
			{ member: "provider-a/mid-model", eligible: false, excluded: "account benched: usage limit" },
			{ member: "provider-b/mid-model", eligible: true },
		],
	},
	model: { provider: "provider-b", id: "mid-model", thinking: "medium" },
	switch: { from: "provider-a/mid-model", cacheMiss: true },
	error: { class: "quota", message: "You have hit your usage limit. Try again in 3 hours.", benchedUntil: "2026-01-01T14:00:00.000Z" },
};

const SUBAGENT: DecisionEntry = {
	...SAMPLE_BASE,
	id: "d_tour_3",
	scope: "subagent",
	reason: "launch",
	tier: { candidate: "deep", chosen: "standard", rank: 2, why: "rule 2 matched; capped at standard for reviewer" },
	model: { provider: "provider-b", id: "mid-model", thinking: "medium" },
	subagent: { agent: "reviewer", taskIndex: 0, toolCallId: "tour", mode: "child", maxTier: "standard" },
};

export interface TourStep {
	title: string;
	lines: string[];
}

export const TOUR_STEPS: TourStep[] = [
	{
		title: "What pi-switchboard does",
		lines: [
			"Each request goes to a model that fits it: a local classifier answers what kind of work it is, how deep and how risky,",
			"your rules turn the answers into a tier, and a strategy picks one of the tier's models.",
			"Every choice is recorded next to the conversation, outside the model's context.",
		],
	},
	{ title: "A small job goes to a small model", lines: [summarize(SMALL_JOB), "", ...explain(SMALL_JOB)] },
	{ title: "When an account hits its limit, work moves on", lines: [summarize(FAILOVER), "", ...explain(FAILOVER)] },
	{ title: "Subagents get their own tier", lines: [summarize(SUBAGENT), "", ...explain(SUBAGENT)] },
	{
		title: "Where to look",
		lines: [
			"/tier try <request>   how a request would route, without running it",
			"/tier explain [id]    the full reasoning of a decision",
			"/tier watch           live view of running work and subagents (Ctrl+Alt+W)",
			"/tier inspect --open  an offline HTML report of this session",
			"/tier doctor          check the setup, with what to fix",
			"/tier init            propose a config from your signed-in models",
		],
	},
];

const NEXT = "Next →";
const CLOSE = "Close";

/** Runs the tour through pi's dialogs; without the TUI, prints every step. */
export async function runTour(ctx: Pick<ExtensionContext, "hasUI" | "ui">, steps: readonly TourStep[] = TOUR_STEPS): Promise<number> {
	if (!ctx.hasUI) {
		ctx.ui.notify(steps.map((step, i) => [`${i + 1}/${steps.length} ${step.title}`, ...step.lines].join("\n")).join("\n\n"), "info");
		return steps.length;
	}
	for (const [index, step] of steps.entries()) {
		const last = index === steps.length - 1;
		const title = [`pi-switchboard tour ${index + 1}/${steps.length}: ${step.title}`, "", ...step.lines].join("\n");
		const choice = await ctx.ui.select(title, last ? [CLOSE] : [NEXT, CLOSE]);
		if (choice !== NEXT) return index + 1;
	}
	return steps.length;
}
