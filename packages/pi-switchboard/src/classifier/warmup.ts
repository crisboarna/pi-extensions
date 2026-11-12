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

/**
 * Loopback in the canonical forms the URL parser writes: IPv4 as four decimal parts (`127.1` becomes `127.0.0.1`), IPv6 compressed and
 * lower-case (`::ffff:127.0.0.1` becomes `::ffff:7f00:1`). Matched as text so this module stays free of network modules.
 */
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4})$/u;

/**
 * A URL is local when its host is `localhost` or a loopback address. A hostname that only starts like one, such as
 * `127.attacker.example`, is a name that DNS resolves anywhere, so it is not local. A private LAN address is not this machine either.
 */
export function isLocalUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.replace(/^\[|\]$/gu, "");
		return host === "localhost" || LOOPBACK.test(host);
	} catch {
		return false;
	}
}
