// Generates media/src/data.json (and data.js for the pages): the decisions the README animations and the
// cover show, produced by the real routing engine on scripted scenarios, so
// every answer, rule, tier, cooldown and pick on screen is one pi-switchboard
// would make. Model names are placeholders.
//
//   node media/data.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifyFn } from "../src/classifier/chain.ts";
import { normalizeConfig } from "../src/config/normalize.ts";
import type { RawConfig } from "../src/config/types.ts";
import { summarize } from "../src/record/describe.ts";
import type { DecisionEntry } from "../src/record/types.ts";
import { type RouteInput, type RouteOutput, SwitchboardEngine } from "../src/router/engine.ts";
import type { Answers } from "../src/rules/types.ts";
import { MemoryHealthStore } from "../src/selection/health.ts";
import { escalate, escalationTrigger } from "../src/tiering/decide.ts";
import { seededRng } from "../src/util/runtime.ts";

const CONFIG: RawConfig = {
	classifiers: [{ model: "local/classifier", timeoutMs: 2000, threshold: 0.85 }],
	profiles: {
		work: {
			tiers: {
				light: { rank: 1, members: ["provider-a/small-model:low"] },
				standard: { rank: 2, members: ["provider-a/mid-model", "provider-b/mid-model", "provider-c/mid-model"], strategy: "ordered" },
				deep: { rank: 3, members: ["provider-a/big-model:high", "provider-b/big-model:high"], strategy: "ordered" },
			},
			fallbackTier: "standard",
		},
	},
	profileSelection: { default: "work" },
};

const answers = (work: string, confidence: number, depth: number, risky: number): Answers => ({
	work: { type: "choice", choice: work, probabilities: { [work]: confidence }, confidence },
	depth: { type: "score", score: depth, confidence: 0.8 },
	risky: { type: "bool", probability: risky },
});

function engine(classify: ClassifyFn, start = Date.UTC(2026, 0, 1, 11)) {
	let now = start;
	const e = new SwitchboardEngine({
		config: normalizeConfig(CONFIG),
		missingConfig: false,
		catalog: { find: () => ({ contextWindow: 200_000 }), hasAuth: () => true, isProvider: () => true, subscription: () => true },
		store: new MemoryHealthStore(),
		classify,
		clock: { now: () => now },
		rng: seededRng(7),
		cwd: "/work/repo",
		home: "/home/dev",
		planPhase: async () => "executing",
		globalProfile: () => undefined,
		subscriptions: () => [],
	});
	return { e, advance: (ms: number) => (now += ms) };
}

const user = (text: string, extra: Partial<RouteInput> = {}): RouteInput => ({
	virtualId: "auto",
	selectedThinking: "medium",
	reason: "user",
	messages: [{ role: "user", content: text }],
	scope: "main",
	...extra,
});

function decisionOf(out: RouteOutput): DecisionEntry {
	if (!out.decision) throw new Error("expected a decision");
	return out.decision;
}

/** A review is classified, rule 2 sends it to the deep tier, and the deep tier's first member is cooling down. */
async function decisionScenario() {
	let next = answers("review", 0.93, 1.6, 0.3);
	const { e, advance } = engine(async () => ({ stopReason: "stop", answers: next }));
	const warm = await e.route(user("look over the release notes"));
	await e.route(
		user("", {
			reason: "retry",
			state: warm.state,
			failed: { provider: "provider-a", id: "big-model", errorMessage: "429 Too Many Requests. Retry-After: 600" },
		}),
	);
	advance(30_000);
	const request = "review this diff for race conditions in the upload queue";
	const confident = decisionOf(await e.route(user(request)));
	next = answers("review", 0.62, 1.6, 0.3);
	const unsure = decisionOf(await e.route(user(request)));
	return { request, confident, unsure, rules: e.config.profiles.work?.ruleset.tierRules ?? [] };
}

/** A usage limit benches account a, a rate limit benches account b's model, and the last member borrows from the tier above. */
async function failoverScenario() {
	const { e, advance } = engine(async () => ({ stopReason: "stop", answers: answers("implement", 0.9, 1.1, 0.1) }));
	const steps: Array<{ label: string; decision: DecisionEntry; model: string }> = [];
	const first = await e.route(user("add retry with backoff to the upload client"));
	steps.push({ label: "request", decision: decisionOf(first), model: `${first.provider}/${first.id}` });
	const limit = "You have hit your usage limit. Try again in 3 hours.";
	e.prepareFailover({ provider: first.provider, id: first.id }, limit);
	const second = await e.route(user("", { reason: "retry", state: first.state, failed: { provider: first.provider, id: first.id, errorMessage: limit } }));
	steps.push({ label: "usage limit", decision: decisionOf(second), model: `${second.provider}/${second.id}` });
	advance(5_000);
	const third = await e.route(
		user("", {
			reason: "retry",
			state: second.state,
			failed: { provider: second.provider, id: second.id, errorMessage: "429 Too Many Requests. Retry-After: 60" },
		}),
	);
	steps.push({ label: "rate limit", decision: decisionOf(third), model: `${third.provider}/${third.id}` });
	advance(5_000);
	const fourth = await e.route(
		user("", {
			reason: "retry",
			state: third.state,
			failed: { provider: third.provider, id: third.id, errorMessage: "429 Too Many Requests. Retry-After: 60" },
		}),
	);
	steps.push({ label: "rate limit", decision: decisionOf(fourth), model: `${fourth.provider}/${fourth.id}` });
	return steps;
}

/** Three subagent tasks get their own tiers; the worker escalates after its tests fail twice. */
async function subagentScenario() {
	const tasks = [
		{ agent: "scout", task: "find where uploads are retried", answers: answers("research", 0.94, 0.4, 0.05) },
		{ agent: "worker", task: "add backoff to the retry loop", answers: answers("implement", 0.9, 1.1, 0.2) },
		{ agent: "reviewer", task: "review the change for race conditions", answers: answers("review", 0.95, 1.6, 0.3) },
	];
	const { e } = engine(async () => ({ stopReason: "error", errorMessage: "unused" }));
	const launches = [];
	for (const task of tasks) {
		const decision = await e.preview(task.task, { answers: task.answers });
		if (!decision) throw new Error("expected a decision");
		launches.push({
			agent: task.agent,
			task: task.task,
			tier: decision.tier.chosen,
			model: `${decision.model.provider}/${decision.model.id}`,
			why: decision.tier.why,
		});
	}
	const profile = e.config.profiles.work;
	if (!profile) throw new Error("missing profile");
	const trigger = escalationTrigger(
		[
			{ tool: "bash", isError: true },
			{ tool: "bash", isError: true },
		],
		profile.escalation,
	);
	const worker = launches[1];
	const escalated = worker ? escalate(worker.tier, profile.tiers) : undefined;
	return { launches, escalation: { agent: worker?.agent, from: worker?.tier, to: escalated, trigger } };
}

const failover = await failoverScenario();
const data = {
	decision: await decisionScenario(),
	failover,
	subagents: await subagentScenario(),
	// The cover's panel patches the standard tier, so its receipt is a standard-tier decision.
	cover: failover[0] ? summarize(failover[0].decision) : "",
};
const json = JSON.stringify(data, null, "\t");
writeFileSync(join(import.meta.dirname, "src", "data.json"), `${json}\n`);
// Pages opened from file:// cannot fetch JSON, so they load the same data as a one-line script; data.json is the readable copy.
writeFileSync(join(import.meta.dirname, "src", "data.js"), `window.MEDIA = ${JSON.stringify(data)};\n`);
console.log(`media data: ${data.cover}`);
