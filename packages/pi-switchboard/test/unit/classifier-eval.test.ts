import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClassifyFn } from "../../src/classifier/chain.ts";
import { evaluateClassifier, formatEval } from "../../src/classifier/eval.ts";
import { SAMPLE_REQUESTS } from "../../src/classifier/samples.ts";
import { classifierCommand } from "../../src/cli/classifier.ts";

const answer = (work: string, confidence: number, depth: number, risky: number) => ({
	work: { type: "choice" as const, choice: work, probabilities: { [work]: confidence }, confidence },
	depth: { type: "score" as const, score: depth, confidence: 1 },
	risky: { type: "bool" as const, probability: risky },
});

/** Answers like a perfect classifier for the labels, so every sample routes as expected. */
const perfect: ClassifyFn = async (_model, request) => {
	const text = JSON.stringify(request.state);
	const sample = SAMPLE_REQUESTS.find((candidate) => text.includes(candidate.request));
	switch (sample?.expected) {
		case "top":
			return { stopReason: "stop", answers: answer("plan", 0.95, 1.9, 0.2) };
		case "middle":
			return { stopReason: "stop", answers: answer("implement", 0.95, 1.1, 0.1) };
		case "middle+":
			return { stopReason: "stop", answers: answer("mechanical", 0.95, 0.2, 0.95) };
		default:
			return { stopReason: "stop", answers: answer("mechanical", 0.95, 0.2, 0.02) };
	}
};

describe("classifier eval", () => {
	it("keeps the shipped samples equal to the routing tests' fixture", () => {
		const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "h2o-calibration.json"), "utf8")) as {
			cases: Array<{ request: string; expected: string }>;
		};
		assert.deepEqual(
			SAMPLE_REQUESTS.map(({ request, expected }) => [request, expected]),
			fixture.cases.map(({ request, expected }) => [request, expected]),
		);
	});

	it("counts the samples a classifier routes as labelled", async () => {
		const report = await evaluateClassifier(perfect, "fake/perfect");
		assert.deepEqual([report.correct, report.under, report.failed, report.results.length], [24, 0, 0, 24]);
	});

	it("tells too low from too high, counts failures, and keeps the warm-up out of the median", async () => {
		let clock = 0;
		let calls = 0;
		const classify: ClassifyFn = async (_model, request) => {
			calls++;
			clock += calls === 1 ? 9000 : 100 + calls;
			const text = JSON.stringify(request.state);
			if (text.includes("race condition")) return { stopReason: "error", errorMessage: "model is unloaded" };
			// Everything mechanical and shallow: top requests land too low, the rest of the light ones are right.
			return { stopReason: "stop", answers: answer("mechanical", 0.95, 0.2, 0.02) };
		};
		const report = await evaluateClassifier(classify, "fake/lazy", { now: () => clock });
		assert.equal(report.failed, 1);
		assert.equal(report.correct, 9);
		assert.equal(report.under, 6 + 5 + 3);
		assert.equal(report.warmupMs, 9000);
		assert.ok(report.medianMs > 100 && report.medianMs < 200, String(report.medianMs));
		const text = formatEval(report);
		assert.match(text, /^classifier eval: fake\/lazy at threshold 0\.8/);
		assert.match(text, /✗ too low +deep +→ light/);
		assert.match(text, /✗ no answer +deep +→ error: model is unloaded/);
		assert.match(text, /9\/24 on the expected tier, 14 too low, 1 without an answer/);
		assert.match(text, /first call 9000 ms \(includes loading the model\)/);
	});
});

describe("pi-switchboard classifier eval against a System One server", () => {
	async function server(handler: (body: { model: string; questions: Record<string, { type: string }> }) => unknown) {
		const http = createServer((request, response) => {
			let text = "";
			request.on("data", (chunk) => (text += chunk));
			request.on("end", () => {
				response.writeHead(request.url === "/v1/systemone" ? 200 : 404, { "content-type": "application/json" });
				response.end(JSON.stringify(handler(JSON.parse(text))));
			});
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		return { http, url: `http://127.0.0.1:${(http.address() as { port: number }).port}/v1` };
	}
	const io = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text), env: { KEY: "secret" } } };
	};

	it("reports the model's routing and exits 0", async () => {
		const { http, url } = await server((body) => ({
			model: body.model,
			answers: {
				work: { type: "choice", choice: "implement", probabilities: { implement: 0.9 }, confidence: 0.9 },
				depth: { type: "score", score: 1, confidence: 0.8 },
				risky: { type: "noul", noul: 0.1 },
			},
		}));
		const run = io();
		try {
			assert.equal(await classifierCommand(["eval", url, "kev-4b", "--json", "--api-key-env", "KEY"], run.io), 0);
		} finally {
			http.close();
		}
		const report = JSON.parse(run.out.join("")) as { model: string; correct: number; failed: number };
		assert.deepEqual([report.model, report.correct, report.failed], ["kev-4b", 9, 0]);
	});

	it("exits 1 when no request is answered, and on bad arguments", async () => {
		const { http, url } = await server(() => ({ error: "no such model" }));
		const run = io();
		try {
			assert.equal(await classifierCommand(["eval", url, "missing"], run.io), 1);
		} finally {
			http.close();
		}
		assert.match(run.out.join(""), /0\/24 on the expected tier, 0 too low, 24 without an answer/);
		const bad = io();
		assert.equal(await classifierCommand(["eval", url], bad.io), 1);
		assert.equal(await classifierCommand(["eval", url, "m", "--threshold", "2"], bad.io), 1);
		assert.equal(await classifierCommand(["eval", url, "m", "--api-key-env", "UNSET"], bad.io), 1);
		assert.match(bad.err.join(""), /Usage|eval <baseUrl> <model>[\s\S]*--threshold must be[\s\S]*UNSET is not set/);
		assert.equal(await classifierCommand([], bad.io), 0);
		assert.equal(await classifierCommand(["nope"], bad.io), 1);
	});
});
