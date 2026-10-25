import type { Question, QuestionSet } from "../rules/types.ts";

/** The default question set: one classify call answers all three. */
export const BUILTIN_QUESTIONS: QuestionSet = {
	work: {
		type: "choice",
		instructions: "What kind of work does the latest request ask for?",
		criteria: {
			plan: "Designing, planning or choosing an approach before writing code",
			research: "Finding and reading information in code, docs or the web",
			implement: "Writing or changing code to build or fix something",
			review: "Checking existing work for defects, risks or quality",
			mechanical: "A small, fully specified step: rename, run a command, look up one fact, summarize",
		},
	},
	depth: {
		type: "score",
		instructions: "How much reasoning does doing this well require?",
		criteria: [
			"Shallow: the answer is obvious or a single step",
			"Moderate: a few steps or some judgement",
			"Deep: hard reasoning, many interacting parts or high ambiguity",
		],
		labels: ["shallow", "moderate", "deep"],
	},
	risky: {
		type: "bool",
		instructions: "Could a wrong or careless result be expensive or destructive?",
		criteria: {
			true: "Data loss, production or infrastructure changes, security, money, or irreversible actions",
			false: "Mistakes are cheap to notice and undo",
		},
	},
};

/** The question as sent to pi's classify(): drops our own `labels` field. */
export function toWireQuestion(question: Question): Question {
	if (question.type !== "score" || !question.labels) return question;
	const { labels: _labels, ...wire } = question;
	return wire;
}

export function toWireQuestions(questions: QuestionSet): QuestionSet {
	return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, toWireQuestion(question)]));
}
