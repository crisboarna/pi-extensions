import type { Answers, QuestionSet } from "../rules/types.ts";
import { type Clock, systemClock } from "../util/runtime.ts";

export interface ClassifyRequest {
	state: Record<string, unknown>;
	questions: QuestionSet;
}

export interface ClassifyResponse {
	stopReason: "stop" | "error" | "aborted";
	answers?: Answers;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cost?: { total?: number } };
}

/** Calls one classifier; implemented over ctx.modelRegistry in pi and faked in tests. */
export type ClassifyFn = (model: string, request: ClassifyRequest, options: { signal: AbortSignal; temperature?: number }) => Promise<ClassifyResponse>;

export interface ChainEntry {
	model: string;
	timeoutMs: number;
	threshold?: number;
	/** The classifier runs off this machine, so it receives the request text. */
	remote?: boolean;
	/** The user allowed a remote classifier to receive request text. */
	allowRemote?: boolean;
}

export interface ChainAttempt {
	model: string;
	ok: boolean;
	latencyMs: number;
	error?: string;
	/** The attempt timed out before the classifier had answered a warm-up. */
	cold?: boolean;
}

export type ChainResult =
	| {
			ok: true;
			model: string;
			answers: Answers;
			threshold?: number;
			latencyMs: number;
			attempts: ChainAttempt[];
			usage?: { input: number; output: number; cost: number };
	  }
	| { ok: false; reason: "classifier-error" | "classifier-cold" | "no-classifier" | "budget"; attempts: ChainAttempt[] };

export interface ChainOptions {
	classify: ClassifyFn;
	budgetMs: number;
	clock?: Clock;
	signal?: AbortSignal;
	temperature?: number;
	/** Whether a classifier has answered since it was loaded; timeouts on cold ones are recorded as cold. */
	isWarm?: (model: string) => boolean;
}

class Timeout extends Error {}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	outer?.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					// Reject first so the race settles as a timeout, not as the aborted call.
					reject(new Timeout(`timed out after ${ms} ms`));
					controller.abort();
				}, ms);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		outer?.removeEventListener("abort", abort);
	}
}

/**
 * Tries each classifier in order until one answers, within each entry's
 * timeout and the decision's total budget. Classifier calls report provider
 * errors through `stopReason`, which counts as a failed attempt.
 */
export async function runClassifierChain(entries: readonly ChainEntry[], request: ClassifyRequest, options: ChainOptions): Promise<ChainResult> {
	const clock = options.clock ?? systemClock;
	const attempts: ChainAttempt[] = [];
	if (entries.length === 0) return { ok: false, reason: "no-classifier", attempts };
	const started = clock.now();
	for (const entry of entries) {
		const remaining = options.budgetMs - (clock.now() - started);
		if (remaining <= 0) return { ok: false, reason: "budget", attempts };
		if (entry.remote && !entry.allowRemote) {
			// Never send request text off this machine without the user's say-so (DESIGN.md 13).
			attempts.push({
				model: entry.model,
				ok: false,
				latencyMs: 0,
				error: "remote classifier skipped: set allowRemote: true on it to send request text off this machine",
			});
			continue;
		}
		const attemptStart = clock.now();
		try {
			const response = await withTimeout(
				(signal) => options.classify(entry.model, request, { signal, ...(options.temperature ? { temperature: options.temperature } : {}) }),
				Math.min(entry.timeoutMs, remaining),
				options.signal,
			);
			const latencyMs = clock.now() - attemptStart;
			if (response.stopReason !== "stop" || !response.answers) {
				attempts.push({ model: entry.model, ok: false, latencyMs, error: response.errorMessage ?? response.stopReason });
				continue;
			}
			attempts.push({ model: entry.model, ok: true, latencyMs });
			const usage = response.usage
				? { input: response.usage.input ?? 0, output: response.usage.output ?? 0, cost: response.usage.cost?.total ?? 0 }
				: undefined;
			return {
				ok: true,
				model: entry.model,
				answers: response.answers,
				...(entry.threshold !== undefined ? { threshold: entry.threshold } : {}),
				latencyMs: clock.now() - started,
				attempts,
				...(usage ? { usage } : {}),
			};
		} catch (error) {
			const timedOut = error instanceof Timeout;
			const cold = timedOut && options.isWarm ? !options.isWarm(entry.model) : undefined;
			attempts.push({
				model: entry.model,
				ok: false,
				latencyMs: clock.now() - attemptStart,
				error: error instanceof Error ? error.message : String(error),
				...(cold ? { cold } : {}),
			});
		}
	}
	const reason = attempts.length > 0 && attempts.every((attempt) => attempt.cold) ? "classifier-cold" : "classifier-error";
	return { ok: false, reason, attempts };
}
