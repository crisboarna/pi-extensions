/** Thinking levels pi understands, weakest first. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** A model named as `provider/id`, optionally with a `:thinking` suffix. */
export interface ModelRef {
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

/**
 * Parses `provider/id[:thinking]`. The provider is everything before the first
 * `/`, so ids that contain `/` (gateway catalogs) stay intact. A trailing
 * `:level` is taken as thinking only when it is a known level.
 */
export function parseModelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	const provider = text.slice(0, slash);
	let id = text.slice(slash + 1);
	let thinking: ThinkingLevel | undefined;
	const colon = id.lastIndexOf(":");
	if (colon > 0) {
		const suffix = id.slice(colon + 1);
		if (isThinkingLevel(suffix)) {
			thinking = suffix;
			id = id.slice(0, colon);
		}
	}
	return thinking ? { provider, id, thinking } : { provider, id };
}

export function formatModelRef(ref: { provider: string; id: string; thinking?: string }): string {
	return ref.thinking ? `${ref.provider}/${ref.id}:${ref.thinking}` : `${ref.provider}/${ref.id}`;
}

/** Moves `level` by `steps` along the thinking scale, clamped to its ends. */
export function shiftThinking(level: ThinkingLevel, steps: number): ThinkingLevel {
	const index = THINKING_LEVELS.indexOf(level);
	const next = Math.min(THINKING_LEVELS.length - 1, Math.max(0, index + steps));
	return THINKING_LEVELS[next] as ThinkingLevel;
}

const ACCOUNT_SUFFIX = /^(.+)-(\d+)$/;

/**
 * Splits a pi-multi-pass account provider such as `<provider>-2` into its
 * base provider and account index. `isProvider` confirms the base exists, so
 * provider names that merely end in a number are left alone.
 */
export function splitAccountProvider(provider: string, isProvider: (name: string) => boolean): { base: string; index?: number } {
	const match = ACCOUNT_SUFFIX.exec(provider);
	if (match?.[1] && match[2] && isProvider(match[1])) return { base: match[1], index: Number(match[2]) };
	return { base: provider };
}
