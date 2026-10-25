export const ERROR_CLASSES = ["quota", "context-overflow", "auth", "rate-limit", "overloaded", "server", "other"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * Default patterns, checked in ERROR_CLASSES order (quota before rate-limit,
 * because usage limits often arrive as HTTP 429). Users can replace a class's
 * patterns with `failover.errorClasses`.
 */
export const DEFAULT_ERROR_PATTERNS: Record<Exclude<ErrorClass, "other">, string[]> = {
	quota: [
		"usage.?limit",
		"insufficient_quota",
		"quota exceeded",
		"exceeded your current quota",
		"usage_not_included",
		"out of budget",
		"billing",
	],
	"context-overflow": [
		"prompt (?:is )?too long",
		"context.{0,20}(?:length|window|size)",
		"too many tokens",
		"token limit exceeded",
		"request_too_large",
		"maximum context",
		"longer than the model'?s context",
	],
	auth: ["\\b401\\b", "\\b403\\b", "unauthori[sz]ed", "invalid[_ -]?api[_ -]?key", "invalid[_ -]?refresh[_ -]?token", "refresh token.*(?:invalid|expired|revoked)", "authentication"],
	"rate-limit": ["rate.?limit", "too many requests", "\\b429\\b", "resourceexhausted"],
	overloaded: ["overloaded", "capacity", "\\b529\\b", "\\b503\\b", "server_busy", "servers are currently busy", "high demand", "temporarily unavailable"],
	server: ["\\b5\\d\\d\\b", "internal.?(?:server.?)?error", "timed? ?out", "econnreset", "socket hang up", "fetch failed", "network.?error", "connection.?(?:error|refused|lost)", "stream ended"],
};

export function classifyError(message: string | undefined, overrides: Record<string, string[]> = {}): ErrorClass {
	if (!message) return "other";
	for (const errorClass of ERROR_CLASSES) {
		if (errorClass === "other") break;
		const patterns = overrides[errorClass] ?? DEFAULT_ERROR_PATTERNS[errorClass];
		for (const source of patterns) {
			try {
				if (new RegExp(source, "iu").test(message)) return errorClass;
			} catch {
				// An invalid user pattern never matches.
			}
		}
	}
	return "other";
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000 };

function durationMs(amount: string, unit: string | undefined): number | undefined {
	const value = Number(amount);
	const scale = UNIT_MS[(unit ?? "s").toLowerCase()];
	return Number.isFinite(value) && scale ? value * scale : undefined;
}

/**
 * When the provider says the request may be retried, as an absolute time.
 * Understands `try again in ~42 min`, `try again in 1m30s`, `retry after 20s`,
 * `Retry-After: 20`, `resets in 3h`, `resets_at: <epoch s|ms>` and ISO times.
 */
export function parseRetryAt(message: string | undefined, now: number): number | undefined {
	if (!message) return undefined;
	const compound = /(?:try again|retry) in ~?\s*(\d+)\s*h(?:ours?)?\s*(\d+)\s*m|(?:try again|retry) in ~?\s*(\d+)\s*m(?:in(?:utes?)?)?\s*(\d+)\s*s/iu.exec(message);
	if (compound) {
		const [, h, hm, m, ms] = compound;
		if (h && hm) return now + Number(h) * 3_600_000 + Number(hm) * 60_000;
		if (m && ms) return now + Number(m) * 60_000 + Number(ms) * 1000;
	}
	const relative = /(?:try again in|retry[- ]after|retry in|resets? in|retry-after:)\s*~?\s*(\d+(?:\.\d+)?)\s*(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hr|h)?\b/iu.exec(message);
	if (relative?.[1]) {
		const ms = durationMs(relative[1], relative[2]);
		if (ms !== undefined) return now + ms;
	}
	const epoch = /resets?_?at["']?\s*[:=]\s*["']?(\d{10,13})/iu.exec(message);
	if (epoch?.[1]) {
		const value = Number(epoch[1]);
		return epoch[1].length >= 13 ? value : value * 1000;
	}
	const iso = /resets?_?at["']?\s*[:=]\s*["']?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/iu.exec(message);
	if (iso?.[1]) {
		const value = Date.parse(iso[1]);
		if (Number.isFinite(value)) return value;
	}
	return undefined;
}

/** Retry time from response headers (`retry-after`, `retry-after-ms`, `x-ratelimit-reset*`). */
export function parseRetryHeaders(headers: Record<string, string>, now: number): number | undefined {
	const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const ms = Number(lower["retry-after-ms"]);
	if (Number.isFinite(ms) && ms > 0) return now + ms;
	const after = lower["retry-after"];
	if (after !== undefined) {
		const seconds = Number(after);
		if (Number.isFinite(seconds)) return now + seconds * 1000;
		const date = Date.parse(after);
		if (Number.isFinite(date)) return date;
	}
	for (const key of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
		const value = lower[key];
		if (!value) continue;
		const parsed = parseRetryAt(`retry in ${value}`, now);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

/** Whether pi's own retry will re-run the request, so `route()` sees `reason: "retry"`. */
export function piRetriesClass(errorClass: ErrorClass): boolean {
	return errorClass === "rate-limit" || errorClass === "overloaded" || errorClass === "server";
}
