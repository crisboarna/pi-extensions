// A client for System One decision servers (LM Studio's /v1/systemone,
// llama-server and compatible shims), text only.
//
// pi gives an installed extension only pi-ai's main entry points, not
// pi-ai/api/*, so pi-switchboard carries this small client instead of
// importing pi-ai's: the same request (bool questions sent as "noul") and the
// same parsed result, without images or provider retries. A classifier sits
// inside a decision budget measured in seconds, and the chain already falls
// through to the next classifier on failure.
import type { ClassifierAnswer, ClassifierContext, ClassifierFunction, ClassifierResult } from "@earendil-works/pi-ai";

const LABEL = "System One API";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function number(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${LABEL} returned an invalid ${field}`);
	return value;
}

/** Turns the server's answers into pi-ai's classifier answers; throws on a missing or malformed one. */
export function parseAnswers(value: unknown, questions: ClassifierContext["questions"]): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${LABEL} returned an unexpected response`);
	const answers: Record<string, ClassifierAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${LABEL} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string" || !isRecord(answer.probabilities))
				throw new Error(`${LABEL} did not return a choice answer for ${id}`);
			const probabilities = Object.fromEntries(Object.entries(answer.probabilities).map(([key, p]) => [key, number(p, `probability for ${id}.${key}`)]));
			answers[id] = { type: "choice", choice: answer.choice, probabilities, confidence: number(answer.confidence, `confidence for ${id}`) };
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
			answers[id] = { type: "score", score: number(answer.score, `score for ${id}`), confidence: number(answer.confidence, `confidence for ${id}`) };
		} else {
			if (answer.type !== "noul") throw new Error(`${LABEL} did not return a bool answer for ${id}`);
			answers[id] = { type: "bool", probability: number(answer.noul, `probability for ${id}`) };
		}
	}
	return answers;
}

const tokens = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export const classifySystemOne: ClassifierFunction = async (model, context, options) => {
	const result: ClassifierResult = { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "stop", timestamp: Date.now() };
	try {
		if (context.images?.length) throw new Error(`${LABEL} images are not supported by pi-switchboard's classifier client`);
		let payload: unknown = {
			model: model.id,
			state: context.state,
			questions: Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id, q.type === "bool" ? { ...q, type: "noul" } : q])),
		};
		payload = (await options?.onPayload?.(payload, model)) ?? payload;
		const signals = [options?.signal, options?.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)].filter((s) => s !== undefined);
		const response = await (options?.fetch ?? fetch)(new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options?.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
				...model.headers,
				...options?.headers,
			},
			body: JSON.stringify(payload),
			...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
		});
		await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
		const text = await response.text();
		if (!response.ok) throw new Error(`${LABEL} returned ${response.status}: ${text.slice(0, 300)}`);
		const body: unknown = JSON.parse(text);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (isRecord(body.usage)) {
			const input = tokens(body.usage.input_tokens);
			const output = tokens(body.usage.output_tokens);
			const cost = { input: (input * model.cost.input) / 1e6, output: (output * model.cost.output) / 1e6, cacheRead: 0, cacheWrite: 0, total: 0 };
			cost.total = cost.input + cost.output;
			result.usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost };
		}
		result.answers = parseAnswers(body.answers, context.questions);
	} catch (error) {
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		result.errorMessage = error instanceof Error ? error.message : String(error);
	}
	return result;
};
