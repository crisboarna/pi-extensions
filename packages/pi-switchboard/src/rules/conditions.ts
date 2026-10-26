import type { Answer, Condition, ConditionValue, Question, QuestionSet, Signals } from "./types.ts";
import { isSignalKey } from "./types.ts";

export type Comparator = "<" | "<=" | ">" | ">=" | "==";

const COMPARISON = /^\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)\s*$/u;

export function parseComparison(text: string): { op: Comparator; value: number } | undefined {
	const match = COMPARISON.exec(text);
	if (!match?.[1] || match[2] === undefined) return undefined;
	return { op: match[1] as Comparator, value: Number(match[2]) };
}

function compare(left: number, op: Comparator, right: number): boolean {
	switch (op) {
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case ">=":
			return left >= right;
		case "==":
			return left === right;
	}
}

function asList(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

/** Checks one condition value against its question; returns a reason when invalid. */
export function validateConditionValue(key: string, value: ConditionValue, questions: QuestionSet): string | undefined {
	if (isSignalKey(key)) {
		const ok = typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
		return ok ? undefined : `${key} must be a string or a list of strings`;
	}
	const question = questions[key];
	if (!question) return `unknown question "${key}"`;
	switch (question.type) {
		case "choice": {
			const labels = Object.keys(question.criteria);
			const raw = typeof value === "object" && !Array.isArray(value) ? value.not : value;
			if (typeof raw !== "string" && !Array.isArray(raw)) return `${key} expects a label, a list of labels or { not }`;
			const unknown = asList(raw).filter((label) => !labels.includes(label));
			return unknown.length ? `${key} has no label ${unknown.map((l) => `"${l}"`).join(", ")}` : undefined;
		}
		case "score": {
			if (typeof value === "number") return Number.isInteger(value) ? undefined : `${key} level must be an integer`;
			if (typeof value === "string" && (parseComparison(value) || question.labels?.includes(value))) return undefined;
			return `${key} expects a comparison such as "<1.0" or one of ${(question.labels ?? []).join(", ") || "its level numbers"}`;
		}
		case "bool":
			if (typeof value === "boolean") return undefined;
			if (typeof value === "string" && parseComparison(value)) return undefined;
			return `${key} expects true, false or a comparison such as ">0.7"`;
	}
}

export function validateCondition(condition: Condition, questions: QuestionSet): string[] {
	const parts = Array.isArray(condition) ? condition : [condition];
	if (parts.length === 0) return ["an empty condition list never matches"];
	const errors: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== "object") {
			errors.push("each condition must be an object");
			continue;
		}
		for (const [key, value] of Object.entries(part)) {
			const reason = validateConditionValue(key, value, questions);
			if (reason) errors.push(reason);
		}
	}
	return errors;
}

/** Whether one answer satisfies one condition value. A missing answer never matches. */
export function matchValue(question: Question | undefined, answer: Answer | undefined, value: ConditionValue): boolean {
	if (!question || !answer) return false;
	if (question.type === "choice" && answer.type === "choice") {
		if (typeof value === "object" && !Array.isArray(value)) return !asList(value.not).includes(answer.choice);
		if (typeof value === "string" || Array.isArray(value)) return asList(value).includes(answer.choice);
		return false;
	}
	if (question.type === "score" && answer.type === "score") {
		if (typeof value === "number") return Math.round(answer.score) === value;
		if (typeof value !== "string") return false;
		const comparison = parseComparison(value);
		if (comparison) return compare(answer.score, comparison.op, comparison.value);
		const level = question.labels?.indexOf(value) ?? -1;
		return level >= 0 && Math.round(answer.score) === level;
	}
	if (question.type === "bool" && answer.type === "bool") {
		if (typeof value === "boolean") return answer.probability >= 0.5 === value;
		const comparison = typeof value === "string" ? parseComparison(value) : undefined;
		return comparison ? compare(answer.probability, comparison.op, comparison.value) : false;
	}
	return false;
}

export function matchSignal(signals: Signals, key: string, value: ConditionValue): boolean {
	if (!isSignalKey(key)) return false;
	const actual = signals[key];
	if (actual === undefined) return false;
	if (typeof value === "string") return actual === value;
	if (Array.isArray(value)) return value.includes(actual);
	return false;
}

/**
 * Confidence that gates a rule, on one scale for every answer type: 0 for an
 * even split, 1 for certainty. Choice uses the server's value
 * (`(n·p_top − 1)/(n − 1)`), bool uses `|2p − 1|`, and score answers do not
 * gate (undefined).
 */
export function gatingConfidence(answer: Answer): number | undefined {
	switch (answer.type) {
		case "choice":
			return answer.confidence;
		case "bool":
			return Math.abs(2 * answer.probability - 1);
		case "score":
			return undefined;
	}
}

export interface ConditionMatch {
	matched: boolean;
	/** Question ids the matched alternative referenced. */
	referenced: string[];
	/** Minimum gating confidence over the referenced choice and bool answers; 1 when none gate. */
	confidence: number;
}

/** Evaluates a condition; with alternatives, the first matching one wins. */
export function evaluateCondition(condition: Condition, questions: QuestionSet, answers: Record<string, Answer>, signals: Signals): ConditionMatch {
	const parts = Array.isArray(condition) ? condition : [condition];
	for (const part of parts) {
		let matched = true;
		const referenced: string[] = [];
		let confidence = 1;
		for (const [key, value] of Object.entries(part)) {
			if (isSignalKey(key)) {
				if (!matchSignal(signals, key, value)) matched = false;
				continue;
			}
			referenced.push(key);
			const answer = answers[key];
			if (!matchValue(questions[key], answer, value)) {
				matched = false;
				continue;
			}
			const gate = answer ? gatingConfidence(answer) : undefined;
			if (gate !== undefined) confidence = Math.min(confidence, gate);
		}
		if (matched) return { matched, referenced, confidence };
	}
	return { matched: false, referenced: [], confidence: 0 };
}
