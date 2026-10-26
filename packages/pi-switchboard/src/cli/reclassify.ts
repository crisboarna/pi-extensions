import { homedir } from "node:os";
import { join } from "node:path";
import type { ClassifyFn } from "../classifier/chain.ts";
import { runClassifierChain } from "../classifier/chain.ts";
import { toWireQuestions } from "../classifier/questions.ts";
import { classifySystemOne } from "../classifier/system-one.ts";
import { loadConfig } from "../config/load.ts";
import type { ClassifierProviderConfig } from "../config/types.ts";
import type { DecisionEntry } from "../record/types.ts";
import { evaluateRules } from "../rules/evaluate.ts";
import type { Answers } from "../rules/types.ts";
import { parseModelRef } from "../util/model-ref.ts";

/**
 * A ClassifyFn for use outside pi: local System One servers are called
 * directly; other classifiers need pi's credentials and are reported as
 * unavailable here.
 */
function standaloneClassify(providers: readonly ClassifierProviderConfig[]): ClassifyFn {
	return async (model, request, options) => {
		const ref = parseModelRef(model);
		const provider = providers.find((p) => p.name === ref?.provider);
		if (!ref || !provider)
			return { stopReason: "error", errorMessage: `${model} is not a local System One classifier; re-run inside pi with /tier explain` };
		const result = await classifySystemOne(
			{
				id: ref.id,
				name: ref.id,
				provider: provider.name,
				api: "typesafe-system-one",
				baseUrl: provider.baseUrl,
				type: "classifier",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
			} as never,
			{ state: request.state as never, questions: toWireQuestions(request.questions) as never },
			{ apiKey: provider.apiKey ?? "local", signal: options.signal },
		);
		return {
			stopReason: result.stopReason,
			...(Object.keys(result.answers).length > 0 ? { answers: result.answers as unknown as Answers } : {}),
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		};
	};
}

/** Re-runs the classifier chain on each decision's recorded evidence with the current config. */
export async function reclassifyDecisions(decisions: readonly DecisionEntry[]): Promise<string[]> {
	const { config } = loadConfig({ agentDir: join(homedir(), ".pi", "agent"), cwd: process.cwd(), projectTrusted: false });
	const classify = standaloneClassify(config.classifierProviders);
	const lines = ["", "Reclassified with the current config:"];
	for (const decision of decisions) {
		const state = decision.evidence?.state;
		const profile = config.profiles[decision.profile.name];
		if (!state || !profile) {
			lines.push(`  ${decision.id}: skipped (${state ? `profile ${decision.profile.name} no longer exists` : "no recorded evidence"})`);
			continue;
		}
		const chain = await runClassifierChain(
			config.classifiers,
			{ state, questions: config.classification.questions },
			{ classify, budgetMs: Math.max(config.classification.decisionBudgetMs, 30_000) },
		);
		if (!chain.ok) {
			lines.push(`  ${decision.id}: classifier unavailable (${chain.attempts.map((a) => a.error).join("; ") || chain.reason})`);
			continue;
		}
		const threshold = profile.threshold ?? chain.threshold ?? config.classification.threshold;
		const signals = {
			$scope: decision.scope,
			...(decision.subagent ? { $agent: decision.subagent.agent } : {}),
			...(typeof state.planMode === "string" ? { $planMode: state.planMode } : {}),
		};
		const outcome = evaluateRules(profile, config.classification.questions, chain.answers, signals, threshold);
		const was = decision.tier.candidate || decision.tier.chosen;
		lines.push(`  ${decision.id}: ${was} → ${outcome.tier}${outcome.tier === was ? "" : "  (changed)"}`);
	}
	return lines;
}
