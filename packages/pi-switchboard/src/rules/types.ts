/** Signal keys: facts known without the classifier. */
export const SIGNAL_KEYS = ["$planMode", "$scope", "$agent"] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];
export type Signals = Partial<Record<SignalKey, string>>;

export function isSignalKey(key: string): key is SignalKey {
	return (SIGNAL_KEYS as readonly string[]).includes(key);
}

/** A rank keyword resolved against a profile's tiers, or a tier name. */
export type TierTarget = string;
export const RANK_KEYWORDS = ["@top", "@middle", "@bottom"] as const;
export type RankKeyword = (typeof RANK_KEYWORDS)[number];

export function isRankKeyword(value: string): value is RankKeyword {
	return (RANK_KEYWORDS as readonly string[]).includes(value);
}

/**
 * One condition value:
 * - choice: a label, a list of labels, or `{ not: label | labels }`
 * - score: a comparison on the expected value (`"<1.0"`, `">=1.5"`) or a level label
 * - bool: `true` / `false`, or a comparison on the probability (`">0.7"`)
 * - signal: a string or a list of strings
 */
export type ConditionValue = string | number | boolean | string[] | { not: string | string[] };

/** All keys must match (object), or any of the objects must match (array). */
export type Condition = Record<string, ConditionValue> | Array<Record<string, ConditionValue>>;

export interface TierRule {
	when?: Condition;
	tier: TierTarget;
}

export interface FloorRule {
	when: Condition;
	atLeast: TierTarget;
}

export interface Ruleset {
	tierRules: TierRule[];
	floorRules?: FloorRule[];
}

/** Questions the classifier answers; the same shapes pi's classify() takes. */
export type Question =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[]; labels?: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export type QuestionSet = Record<string, Question>;

export type Answer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "bool"; probability: number };

export type Answers = Record<string, Answer>;
