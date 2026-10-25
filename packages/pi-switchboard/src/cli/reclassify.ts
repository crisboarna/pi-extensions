import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClassifyFn } from "../classifier/chain.ts";
import { runClassifierChain } from "../classifier/chain.ts";
import { toWireQuestions } from "../classifier/questions.ts";
import { loadConfig } from "../config/load.ts";
import type { ClassifierProviderConfig } from "../config/types.ts";
import type { DecisionEntry } from "../record/types.ts";
import { evaluateRules } from "../rules/evaluate.ts";
import type { Answers } from "../rules/types.ts";
import { parseModelRef } from "../util/model-ref.ts";

/** pi-ai from the installed pi release (`PI_PACKAGE_DIR` or the newest release). */
function piAiRoot(): string | undefined {
	const fromEnv = process.env.PI_PACKAGE_DIR ? join(process.env.PI_PACKAGE_DIR, "..", "pi-ai") : undefined;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	try {
		const latest = readdirSync(releases)
			.filter((name) => /^\d+\.\d+\.\d+$/u.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
			.at(-1);
		const root = latest ? join(releases, latest, "node_modules", "@earendil-works", "pi-ai") : undefined;
		return root && existsSync(root) ? root : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A ClassifyFn for use outside pi: local System One servers are called through
 * pi-ai's own client; other classifiers need pi's credentials and are reported
 * as unavailable here.
 */
async function standaloneClassify(providers: readonly ClassifierProviderConfig[]): Promise<ClassifyFn | undefined> {
	const root = piAiRoot();
	if (!root) return undefined;
	const module = (await import(pathToFileURL(join(root, "dist", "api", "typesafe-system-one.js")).href)) as { classify?: (...args: unknown[]) => Promise<Record<string, unknown>> };
	const classify = module.classify;
	if (!classify) return undefined;
	return async (model, request, options) => {
		const ref = parseModelRef(model);
		const provider = providers.find((p) => p.name === ref?.provider);
		if (!ref || !provider) return { stopReason: "error", errorMessage: `${model} is not a local System One classifier; re-run inside pi with /tier explain` };
		const result = await classify(
			{ id: ref.id, provider: provider.name, api: "typesafe-system-one", baseUrl: provider.baseUrl, type: "classifier", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ state: request.state, questions: toWireQuestions(request.questions) },
			{ apiKey: provider.apiKey ?? "local", signal: options.signal },
		);
		return {
			stopReason: (result.stopReason as "stop" | "error" | "aborted") ?? "error",
			...(result.answers ? { answers: result.answers as Answers } : {}),
			...(typeof result.errorMessage === "string" ? { errorMessage: result.errorMessage } : {}),
		};
	};
}

/** Re-runs the classifier chain on each decision's recorded evidence with the current config. */
export async function reclassifyDecisions(decisions: readonly DecisionEntry[]): Promise<string[]> {
	const { config } = loadConfig({ agentDir: join(homedir(), ".pi", "agent"), cwd: process.cwd(), projectTrusted: false });
	const classify = await standaloneClassify(config.classifierProviders);
	if (!classify) return ["reclassify: could not find pi-ai in the installed pi release"];
	const lines = ["", "Reclassified with the current config:"];
	for (const decision of decisions) {
		const state = decision.evidence?.state;
		const profile = config.profiles[decision.profile.name];
		if (!state || !profile) {
			lines.push(`  ${decision.id}: skipped (${state ? `profile ${decision.profile.name} no longer exists` : "no recorded evidence"})`);
			continue;
		}
		const chain = await runClassifierChain(config.classifiers, { state, questions: config.classification.questions }, { classify, budgetMs: Math.max(config.classification.decisionBudgetMs, 30_000) });
		if (!chain.ok) {
			lines.push(`  ${decision.id}: classifier unavailable (${chain.attempts.map((a) => a.error).join("; ") || chain.reason})`);
			continue;
		}
		const threshold = profile.threshold ?? chain.threshold ?? config.classification.threshold;
		const signals = { $scope: decision.scope, ...(decision.subagent ? { $agent: decision.subagent.agent } : {}), ...(typeof state.planMode === "string" ? { $planMode: state.planMode } : {}) };
		const outcome = evaluateRules(profile, config.classification.questions, chain.answers, signals, threshold);
		const was = decision.tier.candidate || decision.tier.chosen;
		lines.push(`  ${decision.id}: ${was} → ${outcome.tier}${outcome.tier === was ? "" : "  (changed)"}`);
	}
	return lines;
}
