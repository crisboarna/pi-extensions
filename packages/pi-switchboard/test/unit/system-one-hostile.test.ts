// A classifier is a server the user pointed at: a bug in it, or a different server than expected, answers with numbers outside 0 to 1, a body that
// stops half way, or one that never stops. The confidence gate exists to send an uncertain answer to the baseline tier, so an answer that claims a
// confidence of 7 must not pass it. These cases pin that every such answer is an error (the chain then falls through to the next classifier and
// the fallback tier) and never a decision.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { classifySystemOne, parseAnswers } from "../../src/classifier/system-one.ts";

const QUESTIONS = {
	work: { type: "choice", instructions: "Kind of work?", criteria: { plan: "Designing", implement: "Writing code" } },
	depth: { type: "score", instructions: "How deep?", criteria: ["shallow", "deep"] },
	risky: { type: "bool", instructions: "Costly?", criteria: { true: "yes", false: "no" } },
} as const;

const GOOD = {
	work: { type: "choice", choice: "plan", probabilities: { plan: 0.9, implement: 0.1 }, confidence: 0.85 },
	depth: { type: "score", score: 1.4, confidence: 0.7 },
	risky: { type: "noul", noul: 0.2 },
};

const questions = QUESTIONS as never;
const withWork = (change: Record<string, unknown>) => ({ ...GOOD, work: { ...GOOD.work, ...change } });

describe("parseAnswers refuses numbers a probability or a confidence cannot be", () => {
	it("accepts the ends of the range, and float noise just outside them", () => {
		assert.doesNotThrow(() => parseAnswers(withWork({ confidence: 0, probabilities: { plan: 0, implement: 1 } }), questions));
		assert.doesNotThrow(() => parseAnswers(withWork({ confidence: 1 }), questions));
		const noisy = parseAnswers(withWork({ confidence: 1.0000001, probabilities: { plan: 1.0000001, implement: -0.0000001 } }), questions);
		assert.deepEqual(noisy.work, { type: "choice", choice: "plan", probabilities: { plan: 1, implement: 0 }, confidence: 1 });
	});

	for (const confidence of [1.5, 7, 1e308, -0.2, -1e308]) {
		it(`a choice confidence of ${confidence} is refused: it would pass every threshold or none`, () => {
			assert.throws(() => parseAnswers(withWork({ confidence }), questions), /invalid confidence for work/u);
		});
	}

	for (const probability of [3, -1, 1.01]) {
		it(`a choice probability of ${probability} is refused`, () => {
			assert.throws(
				() => parseAnswers(withWork({ probabilities: { plan: probability, implement: 0 } }), questions),
				/invalid probability for work\.plan/u,
			);
		});
		it(`a bool probability of ${probability} is refused: |2p - 1| would be far above any threshold`, () => {
			assert.throws(() => parseAnswers({ ...GOOD, risky: { type: "noul", noul: probability } }, questions), /invalid probability for risky/u);
		});
	}

	it("a score answer's confidence is held to the range too, and its score is only held to be finite", () => {
		assert.throws(() => parseAnswers({ ...GOOD, depth: { type: "score", score: 1, confidence: 7 } }, questions), /invalid confidence for depth/u);
		assert.doesNotThrow(() => parseAnswers({ ...GOOD, depth: { type: "score", score: -3.5, confidence: 0.5 } }, questions));
		assert.throws(
			() => parseAnswers({ ...GOOD, depth: { type: "score", score: Number.POSITIVE_INFINITY, confidence: 0.5 } }, questions),
			/invalid score for depth/u,
		);
	});

	it("numbers that arrive as anything else are refused: text, null, booleans, lists and objects", () => {
		for (const bad of ["0.9", null, true, [], {}]) {
			assert.throws(() => parseAnswers(withWork({ confidence: bad }), questions), /invalid confidence for work/u, JSON.stringify(bad));
		}
	});

	it("a number too large for a double arrives as Infinity from JSON.parse and is refused", () => {
		const body = JSON.parse(
			'{"work":{"type":"choice","choice":"plan","probabilities":{"plan":1,"implement":0},"confidence":1e999},"depth":{"type":"score","score":1,"confidence":1},"risky":{"type":"noul","noul":0}}',
		);
		assert.throws(() => parseAnswers(body, questions), /invalid confidence for work/u);
	});

	it("an answers object with a __proto__ key is read as data: the questions find no answer, and Object.prototype is untouched", () => {
		const hostile = JSON.parse('{"__proto__":{"work":{"type":"choice"}}}');
		assert.throws(() => parseAnswers(hostile, questions), /did not return an answer for work/u);
		assert.equal(({} as Record<string, unknown>).work, undefined);
	});
});

describe("the client against a server that sends a bad body", () => {
	let reply: { status: number; body: string | Buffer } = { status: 200, body: "{}" };
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(reply.body);
		});
	});
	let baseUrl = "";
	before(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
	});
	after(() => server.close());

	const model = {
		id: "decider",
		name: "decider",
		provider: "local",
		api: "typesafe-system-one",
		type: "classifier",
		get baseUrl() {
			return baseUrl;
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
	} as never;
	const context = { state: { request: "design the cache" }, questions: QUESTIONS } as never;

	async function classify(body: string | Buffer, status = 200) {
		reply = { status, body };
		const started = Date.now();
		const result = await classifySystemOne(model, context, { timeoutMs: 5000 });
		return { result, milliseconds: Date.now() - started };
	}

	it("a body cut off half way is an error, never an answer", async () => {
		const whole = JSON.stringify({ answers: GOOD });
		const { result } = await classify(whole.slice(0, whole.length >> 1));
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.answers, {});
	});

	for (const [name, body] of Object.entries({
		null: "null",
		"a number": "42",
		"a string": '"yes"',
		"an empty body": "",
		"answers that are null": '{"answers":null}',
		"answers that are a list": '{"answers":[]}',
	})) {
		it(`${name} is an error`, async () => {
			const { result } = await classify(body);
			assert.equal(result.stopReason, "error", name);
			assert.deepEqual(result.answers, {});
		});
	}

	it("an answer with a confidence of 7 is an error, so the gate is never asked", async () => {
		const { result } = await classify(JSON.stringify({ answers: withWork({ confidence: 7 }) }));
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /invalid confidence for work/u);
		assert.deepEqual(result.answers, {});
	});

	it("5 MB of padding around good answers still gives the answers, quickly", async () => {
		const { result, milliseconds } = await classify(JSON.stringify({ answers: GOOD, padding: "x".repeat(5 * 1024 * 1024) }));
		assert.equal(result.stopReason, "stop");
		assert.equal(result.answers.work?.type, "choice");
		assert.ok(milliseconds < 3000, `took ${milliseconds} ms`);
	});

	it("5 MB that is not JSON is an error, quickly", async () => {
		const { result, milliseconds } = await classify("x".repeat(5 * 1024 * 1024));
		assert.equal(result.stopReason, "error");
		assert.ok(milliseconds < 3000, `took ${milliseconds} ms`);
	});

	it("an error status with a huge body names the status and keeps the message short", async () => {
		const { result } = await classify("e".repeat(5 * 1024 * 1024), 500);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /returned 500/u);
		assert.ok((result.errorMessage ?? "").length < 500, `the message is ${(result.errorMessage ?? "").length} characters`);
	});
});
