import type { ClassifyFn } from "./chain.ts";

/** A tiny fixed request that makes a local server load the model. */
export const WARMUP_REQUEST = {
	state: { scope: "main", request: "warm-up" },
	questions: { ready: { type: "bool" as const, instructions: "Is this a warm-up request?", criteria: { true: "Yes", false: "No" } } },
};

export interface WarmupEntry {
	model: string;
	/** Only local classifiers are warmed. */
	local: boolean;
	warmup?: boolean;
	keepWarmMs?: number | null;
}

export interface Timers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const systemTimers: Timers = {
	setInterval: (fn, ms) => {
		const handle = setInterval(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Sends one background classify call to each local classifier at session
 * start (never blocking), optionally repeats it while idle, and remembers
 * which classifiers have answered so cold-start timeouts can be told apart.
 */
export class WarmupTracker {
	private readonly warm = new Set<string>();
	private readonly handles: unknown[] = [];
	private readonly classify: ClassifyFn;
	private readonly timers: Timers;

	constructor(classify: ClassifyFn, timers: Timers = systemTimers) {
		this.classify = classify;
		this.timers = timers;
	}

	isWarm = (model: string): boolean => this.warm.has(model);

	/** Records an answer from normal traffic; a classifier that answered is warm. */
	markWarm(model: string): void {
		this.warm.add(model);
	}

	start(entries: readonly WarmupEntry[]): Promise<void> {
		const targets = entries.filter((entry) => entry.local && entry.warmup !== false);
		for (const entry of targets) {
			if (entry.keepWarmMs && entry.keepWarmMs > 0) {
				this.handles.push(this.timers.setInterval(() => void this.ping(entry.model), entry.keepWarmMs));
			}
		}
		return Promise.all(targets.map((entry) => this.ping(entry.model))).then(() => undefined);
	}

	stop(): void {
		for (const handle of this.handles.splice(0)) this.timers.clearInterval(handle);
	}

	private async ping(model: string): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 120_000);
		timer.unref?.();
		try {
			const response = await this.classify(model, WARMUP_REQUEST, { signal: controller.signal });
			if (response.stopReason === "stop") this.warm.add(model);
		} catch {
			// A failed warm-up only means the first real decision may be cold.
		} finally {
			clearTimeout(timer);
		}
	}
}

/** Loopback hosts count as local. */
export function isLocalUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.replace(/^\[|\]$/gu, "");
		return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
	} catch {
		return false;
	}
}
