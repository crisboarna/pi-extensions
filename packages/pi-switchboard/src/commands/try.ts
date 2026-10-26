import type { DecisionEntry } from "../record/types.ts";
import type { Answer, Answers, QuestionSet } from "../rules/types.ts";

export interface TryArgs {
	text: string;
	/** Typed answers that stand in for the classifier; undefined when none were given. */
	answers?: Answers;
	errors: string[];
}

const TRUE = new Set(["yes", "true", "y"]);
const FALSE = new Set(["no", "false", "n"]);

function typedAnswer(question: QuestionSet[string], value: string): Answer | string {
	switch (question.type) {
		case "choice":
			return question.criteria[value] !== undefined
				? { type: "choice", choice: value, probabilities: { [value]: 1 }, confidence: 1 }
				: `expects one of ${Object.keys(question.criteria).join(", ")}`;
		case "score": {
			const level = question.labels?.indexOf(value) ?? -1;
			const score = level >= 0 ? level : Number(value);
			return Number.isFinite(score)
				? { type: "score", score, confidence: 1 }
				: `expects a number${question.labels ? ` or one of ${question.labels.join(", ")}` : ""}`;
		}
		case "bool": {
			const lower = value.toLowerCase();
			const probability = TRUE.has(lower) ? 1 : FALSE.has(lower) ? 0 : Number(value);
			return Number.isFinite(probability) && probability >= 0 && probability <= 1
				? { type: "bool", probability }
				: "expects yes, no or a probability between 0 and 1";
		}
	}
}

/**
 * Splits `/tier try` arguments into typed answers and the request text.
 * Leading `question=value` pairs (for questions the config defines) are
 * answers; everything after them, or after `--`, is the request.
 */
export function parseTryArgs(args: readonly string[], questions: QuestionSet): TryArgs {
	const answers: Answers = {};
	const errors: string[] = [];
	let index = 0;
	for (; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			index++;
			break;
		}
		const match = /^([A-Za-z][\w-]*)=(.+)$/u.exec(arg);
		const question = match?.[1] ? questions[match[1]] : undefined;
		if (!match?.[1] || match[2] === undefined || !question) break;
		const answer = typedAnswer(question, match[2]);
		if (typeof answer === "string") errors.push(`${match[1]} ${answer}`);
		else answers[match[1]] = answer;
	}
	const text = args.slice(index).join(" ").trim();
	return { text, ...(Object.keys(answers).length > 0 ? { answers } : {}), errors };
}

function answerText(id: string, answer: Answer): string {
	switch (answer.type) {
		case "choice":
			return `${id}=${answer.choice} (${answer.confidence.toFixed(2)})`;
		case "score":
			return `${id}=${answer.score.toFixed(2)}`;
		case "bool":
			return `${id}=${answer.probability >= 0.5 ? "yes" : "no"} (${answer.probability.toFixed(2)})`;
	}
}

export const TRY_USAGE =
	"Usage: /tier try [question=value ...] <request>, for example /tier try rename foo to bar, or /tier try work=plan depth=1.8 risky=no design the cache";

/** What `/tier try` shows for a preview decision. */
export function formatPreview(text: string, decision: DecisionEntry | undefined, typed: boolean): string[] {
	if (!decision) return [`/tier try: nothing would be routed for "${text}"`];
	const lines = [`/tier try: "${text.length > 80 ? `${text.slice(0, 77)}...` : text}"`];
	if (decision.kind === "inactive") return [...lines, `switchboard is inactive: ${decision.tier.why}`];
	const source = typed ? "typed answers" : decision.classifier?.model ? `${decision.classifier.model}, ${decision.classifier.latencyMs} ms` : "no classifier";
	if (decision.answers)
		lines.push(
			`answers: ${Object.entries(decision.answers)
				.map(([id, answer]) => answerText(id, answer))
				.join(", ")} [${source}]`,
		);
	if (decision.rules) {
		const gate = decision.rules.gate;
		lines.push(
			`rule: ${decision.rules.ruleset} rule ${decision.rules.matched + 1}, ${
				gate.referenced.length === 0
					? "no confidence gate"
					: `gate ${gate.confidence.toFixed(2)} vs ${gate.threshold} ${gate.passed ? "passed" : "failed, so the fallback tier"}`
			}`,
		);
	}
	lines.push(`tier: ${decision.tier.chosen} (${decision.tier.why})`);
	lines.push(
		`model: ${decision.model.provider}/${decision.model.id}${decision.model.thinking ? `:${decision.model.thinking}` : ""}${decision.selection ? ` (${decision.selection.strategy}: ${decision.selection.why})` : ""}`,
	);
	if (!typed && decision.classifier?.failure) {
		lines.push(
			`The classifier did not answer (${decision.classifier.failure}), so this is the fallback tier. Try typed answers: /tier try work=plan depth=1.8 risky=no ${text}`,
		);
	}
	lines.push("Nothing ran; health, cooldowns and routing state are unchanged.");
	return lines;
}
