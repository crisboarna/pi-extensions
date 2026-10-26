import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { classifySystemOne, parseAnswers } from "../../src/classifier/system-one.ts";
import { framed } from "../../src/tui/pi-tui.ts";

interface Seen {
	url?: string;
	headers?: IncomingHttpHeaders;
	body?: Record<string, unknown>;
}

const QUESTIONS = {
	work: { type: "choice", instructions: "Kind of work?", criteria: { plan: "Designing", implement: "Writing code" } },
	depth: { type: "score", instructions: "How deep?", criteria: ["shallow", "deep"] },
	risky: { type: "bool", instructions: "Costly?", criteria: { true: "yes", false: "no" } },
} as const;

const ANSWERS = {
	work: { type: "choice", choice: "plan", probabilities: { plan: 0.9, implement: 0.1 }, confidence: 0.85 },
	depth: { type: "score", score: 1.4, confidence: 0.7 },
	risky: { type: "noul", noul: 0.2 },
};

let seen: Seen = {};
let reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: {} };
const server = createServer((req, res) => {
	let text = "";
	req.on("data", (data) => (text += data));
	req.on("end", () => {
		seen = { url: req.url ?? "", headers: req.headers, body: JSON.parse(text) as Record<string, unknown> };
		setTimeout(() => {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
		}, reply.delayMs ?? 0);
	});
});
let baseUrl = "";
before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});
after(() => server.close());

const model = (cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) =>
	({
		id: "decider",
		name: "decider",
		provider: "local",
		api: "typesafe-system-one",
		type: "classifier",
		baseUrl,
		input: ["text"],
		cost,
		contextWindow: 32_768,
	}) as never;
const context = { state: { request: "design the cache" }, questions: QUESTIONS } as never;

describe("System One client", () => {
	it("sends bool questions as noul, with the key, and parses every answer type and the usage", async () => {
		reply = { status: 200, body: { answers: ANSWERS, usage: { input_tokens: 2000, output_tokens: 0 } } };
		const responses: number[] = [];
		const result = await classifySystemOne(model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), context, {
			apiKey: "secret",
			headers: { "x-extra": "1" },
			onResponse: (response) => void responses.push(response.status),
		});
		assert.equal(seen.url, "/v1/systemone");
		assert.equal(seen.headers?.authorization, "Bearer secret");
		assert.equal(seen.headers?.["x-extra"], "1");
		const sent = seen.body?.questions as Record<string, { type: string }> | undefined;
		assert.equal(sent?.risky?.type, "noul");
		assert.equal(seen.body?.model, "decider");
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.answers.risky, { type: "bool", probability: 0.2 });
		assert.deepEqual(result.answers.depth, { type: "score", score: 1.4, confidence: 0.7 });
		assert.equal(result.answers.work?.type, "choice");
		assert.equal(result.usage?.input, 2000);
		assert.equal(result.usage?.cost.total, 0.002);
		assert.deepEqual(responses, [200]);
	});

	it("lets onPayload replace the request and works without a key or usage", async () => {
		reply = { status: 200, body: { answers: ANSWERS } };
		const result = await classifySystemOne(model(), context, { onPayload: (payload) => ({ ...(payload as object), extra: true }) });
		assert.equal(seen.body?.extra, true);
		assert.equal(seen.headers?.authorization, undefined);
		assert.equal(result.usage, undefined);
		assert.equal(result.stopReason, "stop");
	});

	it("reports HTTP errors, malformed answers and refused images as errors", async () => {
		reply = { status: 400, body: { error: { message: "questions.depth.criteria: Required" } } };
		const http = await classifySystemOne(model(), context);
		assert.equal(http.stopReason, "error");
		assert.match(http.errorMessage ?? "", /returned 400: .*criteria: Required/u);
		reply = { status: 200, body: { answers: { work: ANSWERS.work, depth: ANSWERS.depth } } };
		assert.match((await classifySystemOne(model(), context)).errorMessage ?? "", /did not return an answer for risky/u);
		reply = { status: 200, body: "[]" };
		assert.match((await classifySystemOne(model(), context)).errorMessage ?? "", /unexpected response/u);
		const images = await classifySystemOne(model(), { ...(context as object), images: [{ type: "image", data: "", mimeType: "image/png" }] } as never);
		assert.match(images.errorMessage ?? "", /images are not supported/u);
	});

	it("stops at the timeout and reports a caller's abort as aborted", async () => {
		reply = { status: 200, body: { answers: ANSWERS }, delayMs: 300 };
		const timedOut = await classifySystemOne(model(), context, { timeoutMs: 20 });
		assert.equal(timedOut.stopReason, "error");
		const controller = new AbortController();
		const pending = classifySystemOne(model(), context, { signal: controller.signal });
		controller.abort();
		assert.equal((await pending).stopReason, "aborted");
	});
});

describe("parseAnswers", () => {
	it("rejects answers of the wrong type or with bad numbers", () => {
		const questions = QUESTIONS as never;
		assert.throws(() => parseAnswers({ ...ANSWERS, work: { type: "score", score: 1, confidence: 1 } }, questions), /choice answer for work/u);
		assert.throws(() => parseAnswers({ ...ANSWERS, depth: { type: "choice" } }, questions), /score answer for depth/u);
		assert.throws(() => parseAnswers({ ...ANSWERS, risky: { type: "bool", probability: 1 } }, questions), /bool answer for risky/u);
		assert.throws(() => parseAnswers({ ...ANSWERS, depth: { type: "score", score: "x", confidence: 1 } }, questions), /invalid score for depth/u);
		assert.throws(() => parseAnswers({ ...ANSWERS, work: { ...ANSWERS.work, probabilities: { plan: "x" } } }, questions), /probability for work.plan/u);
	});
});

describe("framed", () => {
	it("draws a border and pads every row so nothing behind the overlay shows", () => {
		const rows = framed(["short", "a row that is far too long for the frame"], 20, (text) => `<${text}>`);
		assert.equal(rows[0], `<╭${"─".repeat(18)}╮>`);
		assert.equal(rows[1], `<│> ${"short".padEnd(16)} <│>`);
		assert.equal(rows.at(-1), `<╰${"─".repeat(18)}╯>`);
		assert.equal(rows.length, 4);
		assert.ok(rows[2]?.includes("…"));
	});
});
