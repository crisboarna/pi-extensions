import { runClassifierChain } from "../classifier/chain.ts";
import { buildEvidence, type PlanPhase } from "../classifier/evidence.ts";
import type { Profile } from "../config/types.ts";
import type { DecisionEntry } from "../record/types.ts";
import { evaluateRules } from "../rules/evaluate.ts";
import type { SwitchboardEngine } from "../router/engine.ts";
import { chooseProfile } from "../router/profiles.ts";
import { decideLaunchTier } from "../tiering/decide.ts";
import { formatModelRef, type ThinkingLevel } from "../util/model-ref.ts";
import { newId } from "../util/runtime.ts";
import type { LaunchTask } from "./tasks.ts";

/** What pi-subagents would run for an agent without a model in the call. */
export type PinLookup = (agent: string, task: string) => Promise<{ model?: string; tools?: string[] } | "unknown">;

export interface LaunchContext {
	engine: SwitchboardEngine;
	toolCallId: string;
	/** The parent's selected virtual model id (`auto`, a profile, ...) when routing, else undefined. */
	parentVirtualId?: string;
	/** The parent's current physical model, `provider/id`, when not routing. */
	parentModel?: string;
	parentThinking: ThinkingLevel;
	planPhase: PlanPhase;
	/** `child`: write tier-pinned virtual models; `launch`: write physical members. */
	mode: "child" | "launch";
	pinLookup: PinLookup;
	/** Whether a model string names one of our virtual models. */
	isSwitchboard: (model: string) => boolean;
}

export interface LaunchResult {
	decisions: DecisionEntry[];
	routed: number;
}

function skipped(ctx: LaunchContext, task: LaunchTask, profile: Profile | undefined, reason: string): DecisionEntry {
	const { engine } = ctx;
	return {
		v: 1,
		id: newId("d_", engine.deps.clock, engine.deps.rng),
		ts: new Date(engine.deps.clock.now()).toISOString(),
		task: 0,
		scope: "subagent",
		reason: "launch",
		kind: "inactive",
		profile: { name: profile?.name ?? "", source: "default" },
		tier: { candidate: "", chosen: "", rank: 0, why: reason },
		model: { provider: "", id: task.model ?? "", thinking: "" },
		switch: { cacheMiss: false },
		subagent: { agent: task.agent, taskIndex: task.index, toolCallId: ctx.toolCallId, mode: "skipped", skipped: reason },
	};
}

/**
 * Routes the tasks of one `subagent` call (DESIGN.md 5.3): skips pinned and
 * excluded tasks, classifies the rest concurrently, picks each launch tier
 * and writes a tier-pinned virtual model (child mode) or a physical member
 * (launch mode) into the task.
 */
export async function routeLaunch(ctx: LaunchContext, tasks: readonly LaunchTask[]): Promise<LaunchResult> {
	const { engine } = ctx;
	const config = engine.config;
	if (!config.subagents.enabled || tasks.length === 0) return { decisions: [], routed: 0 };
	const { choice } = engine.resolveProfile(ctx.parentVirtualId ?? "auto");
	const subProfile = config.subagents.profile ? chooseProfile({ config, fromModel: config.subagents.profile, cwd: engine.deps.cwd, home: engine.deps.home }) : undefined;
	const profile = subProfile?.profile ?? choice?.profile;

	const decisions = await Promise.all(
		tasks.map(async (task): Promise<DecisionEntry> => {
			if (!profile) return skipped(ctx, task, undefined, engine.inactiveReason());
			if (config.subagents.exclude.includes(task.agent)) return skipped(ctx, task, profile, "agent excluded in config");
			if (task.model && !ctx.isSwitchboard(task.model)) return skipped(ctx, task, profile, `the call names model ${task.model}`);
			const pinned = task.model ? undefined : await ctx.pinLookup(task.agent, task.task);
			if (pinned === "unknown") return skipped(ctx, task, profile, "could not tell whether the agent pins a model");
			if (pinned?.model && !ctx.isSwitchboard(pinned.model)) return skipped(ctx, task, profile, `agent settings pin ${pinned.model}`);

			const limits = config.subagents.agents[task.agent];
			const evidence = buildEvidence({
				messages: [],
				request: task.task,
				scope: "subagent",
				agent: { name: task.agent, ...(pinned?.tools ? { tools: pinned.tools } : {}) },
				planPhase: ctx.planPhase,
				limits: config.classification.evidence,
				redact: config.classification.evidence.redact,
				home: engine.deps.home,
			});
			const needsClassifier = !limits?.fixedTier && !(engine.controls.pin?.subagents && engine.controls.pin.target);
			const chain = needsClassifier
				? await runClassifierChain(config.classifiers, { state: evidence.state, questions: config.classification.questions }, {
						classify: engine.deps.classify,
						budgetMs: config.classification.decisionBudgetMs,
						clock: engine.deps.clock,
						...(engine.deps.warmup ? { isWarm: engine.deps.warmup.isWarm } : {}),
					})
				: undefined;
			const signals = { $scope: "subagent", $agent: task.agent, $planMode: ctx.planPhase };
			const threshold = profile.threshold ?? (chain?.ok ? chain.threshold : undefined) ?? config.classification.threshold;
			const outcome = chain?.ok ? evaluateRules(profile, config.classification.questions, chain.answers, signals, threshold) : undefined;
			const tierTarget = outcome && !outcome.fallback ? outcome.tier : profile.fallbackTier;
			const pin = engine.controls.pin?.subagents ? engine.controls.pin.target : undefined;
			const launch = decideLaunchTier(profile, tierTarget, limits, pin);
			const tier = profile.tiers.find((t) => t.name === launch.tier);
			if (!tier) return skipped(ctx, task, profile, `tier ${launch.tier} missing`);

			let model: DecisionEntry["model"];
			let written: string;
			if (ctx.mode === "child") {
				written = `${config.virtualModel.provider}/${profile.name}.${tier.name}:${ctx.parentThinking}`;
				model = { provider: config.virtualModel.provider, id: `${profile.name}.${tier.name}`, thinking: ctx.parentThinking };
			} else {
				const member = tier.members.find((m) => m.enabled) ?? tier.members[0];
				if (!member) return skipped(ctx, task, profile, `tier ${tier.name} has no member`);
				const physical = engine.deps.accountFor ? engine.deps.accountFor(member.provider, member.id) : member.provider;
				const thinking = member.thinking ?? ctx.parentThinking;
				written = formatModelRef({ provider: physical, id: member.id, thinking });
				model = { provider: physical, id: member.id, thinking };
			}
			task.setModel(written);
			const why = outcome?.fallback
				? `confidence ${outcome.gate.confidence.toFixed(2)} below ${outcome.gate.threshold}; ${launch.why}`
				: chain && !chain.ok
					? `${chain.reason}; ${launch.why}`
					: launch.why;
			return {
				v: 1,
				id: newId("d_", engine.deps.clock, engine.deps.rng),
				ts: new Date(engine.deps.clock.now()).toISOString(),
				task: 0,
				scope: "subagent",
				reason: "launch",
				kind: chain && !chain.ok ? "fallback" : outcome?.fallback ? "fallback" : pin ? "pinned" : "classified",
				profile: { name: profile.name, source: subProfile ? "manual-session" : (choice?.source ?? "default") },
				evidence: { digest: evidence.digest, excerpt: evidence.excerpt, tokens: evidence.tokens, truncated: evidence.truncated },
				...(chain
					? {
							classifier: {
								...(chain.ok ? { model: chain.model, ...(chain.usage ? { usage: chain.usage } : {}) } : { failure: chain.reason }),
								latencyMs: chain.ok ? chain.latencyMs : chain.attempts.reduce((sum, a) => sum + a.latencyMs, 0),
								attempts: chain.attempts,
							},
						}
					: {}),
				...(chain?.ok ? { answers: chain.answers } : {}),
				...(outcome ? { rules: { ruleset: profile.rulesetName, matched: outcome.ruleIndex, gate: outcome.gate, floors: outcome.floors } } : {}),
				tier: { candidate: tierTarget, chosen: tier.name, rank: tier.rank, why },
				model,
				switch: { cacheMiss: false },
				subagent: {
					agent: task.agent,
					taskIndex: task.index,
					toolCallId: ctx.toolCallId,
					mode: ctx.mode,
					launchTier: tier.name,
					...(limits?.maxTier ? { maxTier: limits.maxTier } : {}),
				},
			};
		}),
	);
	return { decisions, routed: decisions.filter((d) => d.subagent?.mode !== "skipped").length };
}
