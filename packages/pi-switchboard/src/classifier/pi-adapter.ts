import { classify as systemOneClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierProviderConfig } from "../config/types.ts";
import type { Answers } from "../rules/types.ts";
import { parseModelRef } from "../util/model-ref.ts";
import type { ClassifyFn } from "./chain.ts";
import { toWireQuestions } from "./questions.ts";
import { isLocalUrl } from "./warmup.ts";

/** pi-ai's API id for System One servers; any server answering POST <baseUrl>/systemone works. */
const SYSTEM_ONE_API = "typesafe-system-one";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Registers each configured local classifier server (LM Studio, llama-server,
 * a vLLM/SGLang/MLX shim, ...) as a pi provider whose models are classifiers.
 */
export function registerClassifierProviders(pi: ExtensionAPI, providers: readonly ClassifierProviderConfig[]): string[] {
	const warnings: string[] = [];
	for (const provider of providers) {
		if (!provider.name || !provider.baseUrl || !Array.isArray(provider.models) || provider.models.length === 0) {
			warnings.push(`classifier provider ${JSON.stringify(provider.name)} needs a name, a baseUrl and at least one model`);
			continue;
		}
		pi.registerProvider(provider.name, {
			name: provider.name,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey ?? "local",
			models: provider.models.map((id) => ({
				type: "classifier" as const,
				id,
				name: id,
				api: SYSTEM_ONE_API,
				baseUrl: provider.baseUrl,
				input: ["text" as const],
				cost: ZERO_COST,
				contextWindow: 32_768,
			})),
			classifiers: { [SYSTEM_ONE_API]: { classify: systemOneClassify } },
		});
	}
	return warnings;
}

/** A ClassifyFn over pi's model registry. `getContext` returns the latest extension context. */
export function createClassifyFn(getContext: () => ExtensionContext | undefined): ClassifyFn {
	return async (model, request, options) => {
		const ctx = getContext();
		const ref = parseModelRef(model);
		if (!ctx || !ref) return { stopReason: "error", errorMessage: ctx ? `bad classifier reference ${model}` : "no extension context" };
		const classifier = ctx.modelRegistry.findOfType("classifier", ref.provider, ref.id);
		if (!classifier) return { stopReason: "error", errorMessage: `classifier ${model} is not registered or has no credentials` };
		const result = await ctx.modelRegistry.classify(
			classifier,
			{ state: request.state as never, questions: toWireQuestions(request.questions) as never },
			{ signal: options.signal, ...(options.temperature ? { temperature: options.temperature } : {}) },
		);
		return {
			stopReason: result.stopReason,
			...(result.answers ? { answers: result.answers as unknown as Answers } : {}),
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
			...(result.usage ? { usage: { input: result.usage.input, output: result.usage.output, cost: { total: result.usage.cost.total } } } : {}),
		};
	};
}

/** Whether a classifier runs on this machine, judged by its base URL. */
export function isLocalClassifier(ctx: ExtensionContext, model: string, providers: readonly ClassifierProviderConfig[]): boolean {
	const ref = parseModelRef(model);
	if (!ref) return false;
	const configured = providers.find((provider) => provider.name === ref.provider);
	if (configured) return isLocalUrl(configured.baseUrl);
	const classifier = ctx.modelRegistry.findOfType("classifier", ref.provider, ref.id) as { baseUrl?: string } | undefined;
	return isLocalUrl(classifier?.baseUrl);
}
