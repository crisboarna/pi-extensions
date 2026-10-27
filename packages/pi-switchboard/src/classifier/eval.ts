import { normalizeConfig } from "../config/normalize.ts";
import { BUILTIN_RULESET } from "../rules/builtin.ts";
import { evaluateRules } from "../rules/evaluate.ts";
import type { QuestionSet } from "../rules/types.ts";
import type { ClassifyFn } from "./chain.ts";
import { buildEvidence } from "./evidence.ts";
import { BUILTIN_QUESTIONS } from "./questions.ts";
import { type ExpectedTier, SAMPLE_REQUESTS, type SampleRequest } from "./samples.ts";

/** The profile the samples were labelled for: three tiers on the built-in rules. */
const TIERS = [
	{ name: "light", rank: 0 },
	{ name: "standard", rank: 1 },
	{ name: "deep", rank: 2 },
];
const RANK: Record<string, number> = { light: 0, standard: 1, deep: 2 };
const WANTED: Record<ExpectedTier, number> = { bottom: 0, middle: 1, top: 2, "middle+": 1 };

export interface SampleResult {
	request: string;
	expected: ExpectedTier;
	/** The tier the answers routed to; absent when the classifier failed. */
	tier?: string;
	/** On the expected tier (or above it, for middle+). */
	ok: boolean;
	/** Below the expected tier: the costly kind of mistake, a weak model on hard work. */
	under: boolean;
	ms: number;
	error?: string;
}

export interface EvalReport {
	model: string;
	threshold: number;
	results: SampleResult[];
	correct: number;
	under: number;
	failed: number;
	/** The first call, which often includes loading the model; not counted in the median. */
	warmupMs: number;
	medianMs: number;
}

export interface EvalOptions {
	threshold?: number;
	timeoutMs?: number;
	questions?: QuestionSet;
	samples?: readonly SampleRequest[];
	now?: () => number;
}

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length === 0 ? 0 : sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * Asks a classifier about each labelled request, as pi-switchboard would for a user turn in the main
 * session, and routes its answers through the built-in rules: how many land on the expected tier,
 * how many land below it, and how fast it answers. A warm-up call comes first, so the model's
 * loading time is reported apart from the per-request latency.
 */
export async function evaluateClassifier(classify: ClassifyFn, model: string, options: EvalOptions = {}): Promise<EvalReport> {
	const { threshold = 0.8, timeoutMs = 30_000, questions = BUILTIN_QUESTIONS, samples = SAMPLE_REQUESTS, now = Date.now } = options;
	const limits = normalizeConfig({}).classification.evidence;
	const ask = async (request: string) => {
		const { state } = buildEvidence({ messages: [{ role: "user", content: request }], scope: "main", planPhase: "executing", limits });
		const started = now();
		const response = await classify(model, { state, questions }, { signal: AbortSignal.timeout(timeoutMs) });
		return { response, ms: now() - started };
	};
	const warmup = await ask(samples[0]?.request ?? "warm up");
	const results: SampleResult[] = [];
	for (const { request, expected } of samples) {
		const { response, ms } = await ask(request);
		if (response.stopReason !== "stop" || !response.answers) {
			results.push({ request, expected, ok: false, under: false, ms, error: response.errorMessage ?? response.stopReason });
			continue;
		}
		const profile = { ruleset: BUILTIN_RULESET, tiers: TIERS, fallbackTier: "standard" };
		const tier = evaluateRules(profile, questions, response.answers, { $scope: "main" }, threshold).tier;
		const got = RANK[tier] ?? -1;
		const want = WANTED[expected];
		results.push({ request, expected, tier, ok: expected === "middle+" ? got >= want : got === want, under: got < want, ms });
	}
	const answered = results.filter((result) => result.tier !== undefined);
	return {
		model,
		threshold,
		results,
		correct: results.filter((result) => result.ok).length,
		under: results.filter((result) => result.under).length,
		failed: results.length - answered.length,
		warmupMs: warmup.ms,
		medianMs: median(answered.map((result) => result.ms)),
	};
}

const LABEL: Record<ExpectedTier, string> = { bottom: "light", middle: "standard", top: "deep", "middle+": "standard+" };

/** The report as text: one line per request, then the totals. */
export function formatEval(report: EvalReport): string {
	const lines = report.results.map((result) => {
		const mark = result.ok ? "✓" : result.under ? "✗ too low" : result.tier ? "✗ too high" : "✗ no answer";
		const got = result.tier ?? `error: ${result.error}`;
		return `${mark.padEnd(11)} ${LABEL[result.expected].padEnd(9)} → ${got.padEnd(8)} ${String(Math.round(result.ms)).padStart(5)} ms  ${result.request}`;
	});
	const total = report.results.length;
	return [
		`classifier eval: ${report.model} at threshold ${report.threshold}`,
		"",
		"result      expected    got      latency  request",
		...lines,
		"",
		`${report.correct}/${total} on the expected tier, ${report.under} too low, ${report.failed} without an answer`,
		`median ${Math.round(report.medianMs)} ms per request; first call ${Math.round(report.warmupMs)} ms (includes loading the model)`,
	].join("\n");
}
