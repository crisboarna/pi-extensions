import type { Answers } from "../rules/types.ts";
import type { ClassifyFn } from "./chain.ts";
import { toWireQuestions } from "./questions.ts";
import { classifySystemOne } from "./system-one.ts";

export interface SystemOneServer {
	/** The provider name the model references use (`<name>/<model>`). */
	name: string;
	/** The server's API root, the part before `/systemone`, for example `http://127.0.0.1:1234/v1/`. */
	baseUrl: string;
	apiKey?: string;
}

/**
 * A ClassifyFn for use outside pi: calls a System One server directly, for `<name>/<model>`
 * references whose provider is one of `servers`. Other classifiers need pi's credentials and
 * report that instead.
 */
export function systemOneClassify(servers: readonly SystemOneServer[], fetcher?: typeof fetch): ClassifyFn {
	return async (model, request, options) => {
		const slash = model.indexOf("/");
		const server = slash > 0 ? servers.find((candidate) => candidate.name === model.slice(0, slash)) : undefined;
		if (!server)
			return {
				stopReason: "error",
				errorMessage: `${model} is not a System One classifier this command can reach; check it inside pi with /tier doctor`,
			};
		const id = model.slice(slash + 1);
		const result = await classifySystemOne(
			{
				id,
				name: id,
				provider: server.name,
				api: "typesafe-system-one",
				baseUrl: server.baseUrl,
				type: "classifier",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
			} as never,
			{ state: request.state as never, questions: toWireQuestions(request.questions) as never },
			{ apiKey: server.apiKey ?? "local", signal: options.signal, ...(fetcher ? { fetch: fetcher } : {}) },
		);
		return {
			stopReason: result.stopReason,
			...(Object.keys(result.answers).length > 0 ? { answers: result.answers as unknown as Answers } : {}),
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		};
	};
}
