import { homedir } from "node:os";
import { join } from "node:path";
import { runClassifierChain } from "../classifier/chain.ts";
import { systemOneClassify } from "../classifier/standalone.ts";
import { loadConfig } from "../config/load.ts";
import type { DecisionEntry } from "../record/types.ts";
import { evaluateRules } from "../rules/evaluate.ts";

/** Re-runs the classifier chain on each decision's recorded evidence with the current config. */
export async function reclassifyDecisions(decisions: readonly DecisionEntry[]): Promise<string[]> {
	const { config } = loadConfig({ agentDir: join(homedir(), ".pi", "agent"), cwd: process.cwd(), projectTrusted: false });
	const classify = systemOneClassify(config.classifierProviders);
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
