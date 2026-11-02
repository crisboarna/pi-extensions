// The contract with a real classifier server, replayed. test/recordings/llamacpp.jsonl holds what a pinned llama.cpp build answered to this package's own
// detect and System One client (recorded by test/recordings/record.ts). These tests run the current code against those real bytes with no server, so a change
// that stops parsing what the server really sends fails here, and a change to what the client asks fails here as well and says to record again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectClassifiers, knownServers, listModels, preferredModel } from "../../src/classifier/detect.ts";
import { BUILTIN_QUESTIONS } from "../../src/classifier/questions.ts";
import { systemOneClassify } from "../../src/classifier/standalone.ts";
import { classifySystemOne, parseAnswers } from "../../src/classifier/system-one.ts";
import { type Exchange, fromJsonl, replayFetch } from "../support/recording.ts";

const { meta, exchanges } = fromJsonl(readFileSync(join(import.meta.dirname, "..", "recordings", "llamacpp.jsonl"), "utf8"));
const server = knownServers().find((candidate) => candidate.name === "llamacpp");
assert.ok(server, "the server catalog has a llamacpp entry");

const classifications = exchanges.filter((exchange) => exchange.request.method === "POST" && exchange.request.path.endsWith("/systemone"));
const requestOf = (exchange: Exchange): string => String((exchange.request.body as { state: { request: unknown } }).state.request);
const bodyOf = (exchange: Exchange): { answers: unknown; usage?: { input_tokens: number; output_tokens: number } } => JSON.parse(exchange.response.body);

/** A replaying fetch that also keeps every request body it was asked, so what the client sends can be compared with what was recorded. */
function spy() {
	const inner = replayFetch(exchanges);
	const sent: Array<{ path: string; body: unknown }> = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		sent.push({ path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		return inner(input, init);
	};
	return { fetcher, sent };
}

describe("the recording", () => {
	it("says what answered: a build pinned by digest, a model and a day", () => {
		assert.equal(meta.server, "llama.cpp");
		assert.match(meta.image, /@sha256:[0-9a-f]{64}$/u);
		assert.match(meta.recordedAt, /^\d{4}-\d{2}-\d{2}$/u);
		assert.ok(meta.model.length > 0);
	});

	it("holds the model list and classifications that point different ways", () => {
		assert.ok(exchanges.some((exchange) => exchange.request.method === "GET" && exchange.request.path === "/v1/models"));
		const choices = new Set(
			classifications.map((exchange) => (parseAnswers(bodyOf(exchange).answers, BUILTIN_QUESTIONS).work as { choice: string }).choice),
		);
		assert.ok(choices.size >= 3, `the recorded answers choose ${[...choices].join(", ")}`);
	});

	it("holds no home folder of the person who recorded it", () => {
		assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "recordings", "llamacpp.jsonl"), "utf8"), /\/Users\/|\/home\//u);
	});
});

describe("detect against the recorded server", () => {
	it("reads the model list the server really sends", async () => {
		const found = await listModels(server as NonNullable<typeof server>, { fetch: replayFetch(exchanges) });
		assert.ok(found, "the recorded list was read");
		assert.deepEqual(found.decisionModels, [meta.model]);
		assert.equal(found.baseUrl, `${found.origin}/v1`);
		assert.equal(preferredModel(found.decisionModels), meta.model);
	});

	it("smoke-tests the model with the three questions and the recorded answer passes", async () => {
		const { fetcher, sent } = spy();
		const detected = await detectClassifiers({ servers: [server as NonNullable<typeof server>], fetch: fetcher, now: () => 0 });
		assert.equal(detected.length, 1);
		assert.equal(detected[0]?.smoke?.ok, true, JSON.stringify(detected[0]?.smoke));
		assert.equal(detected[0]?.smoke?.model, meta.model);
		assert.ok(sent.some((request) => request.path === "/v1/systemone"));
	});
});

describe("the System One client against the recorded server", () => {
	for (const exchange of classifications) {
		it(`reads the answers to "${requestOf(exchange)}" as the server meant them`, async () => {
			const { fetcher, sent } = spy();
			const classify = systemOneClassify([{ name: "llamacpp", baseUrl: `${server?.origin}/v1/` }], fetcher);
			const result = await classify(
				`llamacpp/${meta.model}`,
				{ state: { request: requestOf(exchange) }, questions: BUILTIN_QUESTIONS },
				{ signal: AbortSignal.timeout(10_000) },
			);
			assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
			// What the client reads equals the recorded answers parsed by the same rules, and every number it kept is a real probability or confidence.
			assert.deepEqual(result.answers, parseAnswers(bodyOf(exchange).answers, BUILTIN_QUESTIONS));
			const work = result.answers?.work as { choice: string; probabilities: Record<string, number>; confidence: number };
			assert.ok(Object.keys(BUILTIN_QUESTIONS.work?.criteria ?? {}).includes(work.choice), `the server chose ${work.choice}`);
			for (const value of [...Object.values(work.probabilities), work.confidence]) assert.ok(value >= 0 && value <= 1, `${value} is not between 0 and 1`);
			assert.ok(Math.abs(Object.values(work.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 0.01, "the probabilities add up to one");
			// And the client still asks what it asked when this was recorded; if the questions change on purpose, record again.
			assert.deepEqual(sent.at(-1)?.body, exchange.request.body, "the request differs from the recorded one: record the server again");
		});
	}

	it("reads the token usage the server reports", async () => {
		const exchange = classifications[0];
		assert.ok(exchange);
		const model = {
			id: meta.model,
			name: meta.model,
			provider: "llamacpp",
			api: "typesafe-system-one",
			type: "classifier",
			baseUrl: `${server?.origin}/v1/`,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
		} as never;
		const result = await classifySystemOne(
			model,
			{ state: { request: requestOf(exchange) }, questions: BUILTIN_QUESTIONS } as never,
			{ fetch: replayFetch(exchanges) } as never,
		);
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
		assert.equal(result.usage?.input, bodyOf(exchange).usage?.input_tokens);
		assert.equal(result.usage?.output, bodyOf(exchange).usage?.output_tokens);
	});
});
