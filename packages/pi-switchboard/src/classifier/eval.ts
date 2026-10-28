import { normalizeConfig } from "../config/normalize.ts";
import { BUILTIN_RULESET } from "../rules/builtin.ts";
import { evaluateRules } from "../rules/evaluate.ts";
import type { Answers, QuestionSet } from "../rules/types.ts";
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
	/** The classifier's answers, so other thresholds can be tried without asking again. */
	answers?: Answers;
}

/** How the same answers route at one threshold. */
export interface ThresholdResult {
	threshold: number;
	correct: number;
	under: number;
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
	/** The same answers routed at other thresholds. */
	sweep: ThresholdResult[];
	/** The threshold that routes the most samples as labelled, preferring fewer too low, then the higher threshold. */
	best: ThresholdResult;
	/** Set when eval stopped early: the warm-up and the first request failed with `error`, and `notAsked` requests were left. */
	stopped?: { error: string; notAsked: number };
}

/** The timeout a classifier gets when nothing was measured. */
export const DEFAULT_TIMEOUT_MS = 2000;

/** A classifier's timeout from its measured median: twice it, rounded up to half a second, at least the default. */
export function timeoutFor(medianMs: number): number {
	return Math.max(DEFAULT_TIMEOUT_MS, Math.ceil((medianMs * 2) / 500) * 500);
}

/** Thresholds the sweep tries; models differ in how confident they sound, so the right cutoff differs too. */
export const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];

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
	const profile = { ruleset: BUILTIN_RULESET, tiers: TIERS, fallbackTier: "standard" };
	const route = (answers: Answers, expected: ExpectedTier, at: number) => {
		const tier = evaluateRules(profile, questions, answers, { $scope: "main" }, at).tier;
		const got = RANK[tier] ?? -1;
		const want = WANTED[expected];
		return { tier, ok: expected === "middle+" ? got >= want : got === want, under: got < want };
	};
	const results: SampleResult[] = [];
	const warmupFailed = warmup.response.stopReason !== "stop" || !warmup.response.answers;
	let stopped: EvalReport["stopped"];
	for (const { request, expected } of samples) {
		const { response, ms } = await ask(request);
		if (response.stopReason !== "stop" || !response.answers) {
			const error = response.errorMessage ?? response.stopReason;
			results.push({ request, expected, ok: false, under: false, ms, error });
			// A server that is down, a missing key or a missing endpoint fails every request the same way.
			if (warmupFailed && results.length === 1) {
				stopped = { error, notAsked: samples.length - results.length };
				break;
			}
			continue;
		}
		results.push({ request, expected, ...route(response.answers, expected, threshold), ms, answers: response.answers });
	}
	const answered = results.filter((result) => result.tier !== undefined);
	const sweep = SWEEP.map((at) => {
		const routed = answered.map((result) => route(result.answers ?? {}, result.expected, at));
		return { threshold: at, correct: routed.filter((r) => r.ok).length, under: routed.filter((r) => r.under).length };
	});
	const best = sweep.reduce((a, b) => (b.correct > a.correct || (b.correct === a.correct && b.under <= a.under) ? b : a));
	return {
		model,
		threshold,
		results,
		correct: results.filter((result) => result.ok).length,
		under: results.filter((result) => result.under).length,
		failed: results.length - answered.length,
		warmupMs: warmup.ms,
		medianMs: median(answered.map((result) => result.ms)),
		sweep,
		best,
		...(stopped === undefined ? {} : { stopped }),
	};
}

const LABEL: Record<ExpectedTier, string> = { bottom: "light", middle: "standard", top: "deep", "middle+": "standard+" };

/** The report as text: one line per request, then the totals; or the error once, when nothing answered. */
export function formatEval(report: EvalReport): string {
	if (report.results.every((result) => result.tier === undefined)) {
		const error = report.stopped?.error ?? report.results[0]?.error ?? "no answer";
		const notAsked = report.stopped?.notAsked ?? 0;
		return [
			`classifier eval: ${report.model} at threshold ${report.threshold}`,
			"",
			`${report.model} did not answer: ${error}`,
			...(notAsked > 0 ? [`The other ${notAsked} requests were not asked.`] : []),
		].join("\n");
	}
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
		"",
		`at other thresholds: ${report.sweep.map((t) => `${t.threshold} ${t.correct}/${total}${t.under ? ` (${t.under} too low)` : ""}`).join(", ")}`,
		`suggested "threshold": ${report.best.threshold} (${report.best.correct}/${total}, ${report.best.under} too low)`,
		`suggested "timeoutMs": ${timeoutFor(report.medianMs)} (twice the median, at least ${DEFAULT_TIMEOUT_MS})`,
	].join("\n");
}
