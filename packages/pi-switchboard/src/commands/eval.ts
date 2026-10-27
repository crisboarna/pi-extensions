import type { ClassifyFn } from "../classifier/chain.ts";
import { evaluateClassifier, formatEval } from "../classifier/eval.ts";
import { SAMPLE_REQUESTS } from "../classifier/samples.ts";

export const EVAL_USAGE = "/tier eval [provider/model] [--threshold 0.8] [--temperature 2] [--yes]";

export interface EvalDeps {
	classify: ClassifyFn;
	/** Whether pi has the classifier and its credentials. */
	registered(model: string): boolean;
	isLocal(model: string): boolean;
	/** The configured classifiers, in order; the first is the default model. */
	classifiers: ReadonlyArray<{ model: string; threshold?: number }>;
	defaultThreshold: number;
	defaultTemperature?: number;
	hasUI: boolean;
	confirm(title: string, message: string): Promise<boolean>;
	notify(text: string, level: "info" | "warning" | "error"): void;
}

function option(args: string[], name: string): number | undefined {
	const index = args.indexOf(name);
	const value = index >= 0 ? Number(args[index + 1]) : undefined;
	return value === undefined || Number.isNaN(value) ? undefined : value;
}

/**
 * `/tier eval`: asks any classifier pi knows (a local decision server, a chat model a local server
 * reads token probabilities from, a hosted classifier) about the labelled sample requests and shows how they would route. A remote classifier
 * receives only the sample texts, never the session's; it still asks first, since each request may cost.
 */
export async function runEval(args: string[], deps: EvalDeps): Promise<void> {
	const model =
		args.find((arg, index) => !arg.startsWith("--") && !["--threshold", "--temperature"].includes(args[index - 1] ?? "")) ?? deps.classifiers[0]?.model;
	if (!model) return deps.notify(`No classifier is configured; name one.\nUsage: ${EVAL_USAGE}`, "error");
	if (!deps.registered(model))
		return deps.notify(`${model} is not a classifier pi knows, or it has no credentials. /tier doctor lists what is registered.`, "error");
	const threshold = option(args, "--threshold") ?? deps.classifiers.find((entry) => entry.model === model)?.threshold ?? deps.defaultThreshold;
	if (!(threshold >= 0 && threshold <= 1)) return deps.notify("--threshold must be a number from 0 to 1", "error");
	const temperature = option(args, "--temperature") ?? deps.defaultTemperature;
	const requests = SAMPLE_REQUESTS.length + 1;
	if (!deps.isLocal(model) && !args.includes("--yes")) {
		const message = `${model} runs off this machine. This sends it ${requests} requests with pi-switchboard's sample texts (none of your session), which your provider may charge for.`;
		if (!deps.hasUI) return deps.notify(`${message} Add --yes to go ahead.`, "warning");
		if (!(await deps.confirm(`Evaluate ${model}?`, message))) return;
	}
	deps.notify(`Asking ${model} about ${SAMPLE_REQUESTS.length} labelled requests…`, "info");
	const classify: ClassifyFn = (ref, request, options) => deps.classify(ref, request, { ...options, ...(temperature ? { temperature } : {}) });
	const report = await evaluateClassifier(classify, model, { threshold });
	deps.notify(formatEval(report), "info");
}
