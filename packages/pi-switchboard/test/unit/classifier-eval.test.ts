import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClassifyFn } from "../../src/classifier/chain.ts";
import { evaluateClassifier, formatEval, timeoutFor } from "../../src/classifier/eval.ts";
import { SAMPLE_REQUESTS } from "../../src/classifier/samples.ts";
import { classifierCommand } from "../../src/cli/classifier.ts";
import { type EvalDeps, runEval } from "../../src/commands/eval.ts";

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
		assert.deepEqual(report.best, { threshold: 0.85, correct: 24, under: 0 });
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
		assert.match(text, /at other thresholds: 0\.5 9\/24 \(14 too low\), 0\.6 9\/24/);
		assert.match(text, /suggested "threshold": 0\.95 \(9\/24, 14 too low\)/);
		// The config needs a timeout too: twice the median, so a 3 s classifier is not cut off at the default 2 s.
		assert.match(text, /suggested "timeoutMs": 2000 \(twice the median, at least 2000\)/);
		const slow = formatEval({ ...report, medianMs: 3696 });
		assert.match(slow, new RegExp(`suggested "timeoutMs": ${timeoutFor(3696)} `));
	});

	it("stops when the warm-up and the first request both fail, and suggests nothing when nothing answers", async () => {
		let calls = 0;
		const down: ClassifyFn = async () => {
			calls++;
			return { stopReason: "error", errorMessage: "fetch failed" };
		};
		const report = await evaluateClassifier(down, "fake/down");
		assert.equal(calls, 2, "the warm-up and the first request, not 25 calls");
		assert.deepEqual(report.stopped, { error: "fetch failed", notAsked: 23 });
		assert.equal(report.failed, report.results.length);
		const text = formatEval(report);
		assert.match(text, /fake\/down did not answer: fetch failed\nThe other 23 requests were not asked\./);
		assert.doesNotMatch(text, /suggested|at other thresholds|→ error|timeoutMs/);
		// A first load can outlast the warm-up's timeout; the requests after it still count.
		let n = 0;
		const slowStart: ClassifyFn = async (model, request, options) =>
			++n === 1 ? { stopReason: "error", errorMessage: "timed out" } : perfect(model, request, options);
		const warm = await evaluateClassifier(slowStart, "fake/slow");
		assert.deepEqual([warm.stopped, warm.correct], [undefined, 24]);
		// Answers stop part way: the rows show which failed, and the totals still suggest a threshold.
		let m = 0;
		const flaky: ClassifyFn = async (model, request, options) =>
			++m > 13 ? { stopReason: "error", errorMessage: "server went away" } : perfect(model, request, options);
		const partial = formatEval(await evaluateClassifier(flaky, "fake/flaky"));
		assert.match(partial, /✗ no answer .*error: server went away/);
		assert.match(partial, /suggested "threshold"/);
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
		assert.match(run.out.join(""), /\nmissing did not answer: .+\nThe other 23 requests were not asked\./);
		const bad = io();
		assert.equal(await classifierCommand(["eval", url], bad.io), 1);
		assert.equal(await classifierCommand(["eval", url, "m", "--threshold", "2"], bad.io), 1);
		assert.equal(await classifierCommand(["eval", url, "m", "--api-key-env", "UNSET"], bad.io), 1);
		assert.match(bad.err.join(""), /Usage|eval <baseUrl> <model>[\s\S]*--threshold must be[\s\S]*UNSET is not set/);
		assert.equal(await classifierCommand([], bad.io), 0);
		assert.equal(await classifierCommand(["nope"], bad.io), 1);
	});
});

describe("classifier eval threshold sweep", () => {
	it("suggests the threshold that routes the most samples as labelled", async () => {
		// Sure about light work, unsure about everything else: a low threshold trusts the unsure answers.
		const classify: ClassifyFn = async (_model, request) => {
			const text = JSON.stringify(request.state);
			const sample = SAMPLE_REQUESTS.find((candidate) => text.includes(candidate.request));
			if (sample?.expected === "top") return { stopReason: "stop", answers: answer("plan", 0.65, 1.9, 0.2) };
			if (sample?.expected === "bottom") return { stopReason: "stop", answers: answer("mechanical", 0.95, 0.2, 0.02) };
			return { stopReason: "stop", answers: answer("implement", 0.95, 1.1, 0.1) };
		};
		const report = await evaluateClassifier(classify, "fake/unsure");
		const at = (threshold: number) => report.sweep.find((entry) => entry.threshold === threshold);
		assert.deepEqual(at(0.6), { threshold: 0.6, correct: 24, under: 0 });
		assert.deepEqual(at(0.8)?.correct, 18);
		assert.deepEqual(report.best, { threshold: 0.6, correct: 24, under: 0 });
	});
});

describe("/tier eval", () => {
	const deps = (over: Partial<EvalDeps> = {}) => {
		const notices: Array<[string, string]> = [];
		const seen: Array<number | undefined> = [];
		const confirms: string[] = [];
		const value: EvalDeps = {
			classify: async (model, request, options) => {
				seen.push(options.temperature);
				return perfect(model, request, options);
			},
			registered: (model) => model !== "gone/model",
			isLocal: (model) => model.startsWith("local/"),
			classifiers: [{ model: "local/judge", threshold: 0.7 }],
			defaultThreshold: 0.85,
			hasUI: true,
			confirm: async (title) => {
				confirms.push(title);
				return false;
			},
			notify: (text, level) => void notices.push([level, text]),
			...over,
		};
		return { value, notices, seen, confirms };
	};

	it("evaluates the first configured classifier at its threshold, with the configured temperature", async () => {
		const run = deps({ defaultTemperature: 2 });
		await runEval([], run.value);
		const report = run.notices.at(-1)?.[1] ?? "";
		assert.match(report, /^classifier eval: local\/judge at threshold 0\.7/);
		assert.match(report, /24\/24 on the expected tier/);
		assert.ok(run.seen.every((temperature) => temperature === 2));
	});

	it("asks before sending sample requests to a remote classifier, and refuses without a UI unless --yes", async () => {
		const ui = deps();
		await runEval(["openai/gpt-6-luna"], ui.value);
		assert.deepEqual(ui.confirms, ["Evaluate openai/gpt-6-luna?"]);
		assert.equal(ui.seen.length, 0);
		const headless = deps({ hasUI: false });
		await runEval(["openai/gpt-6-luna", "--threshold", "0.6"], headless.value);
		assert.match(headless.notices[0]?.[1] ?? "", /runs off this machine[\s\S]*25 requests[\s\S]*--yes/);
		await runEval(["openai/gpt-6-luna", "--threshold", "0.6", "--yes"], headless.value);
		assert.match(headless.notices.at(-1)?.[1] ?? "", /^classifier eval: openai\/gpt-6-luna at threshold 0\.6/);
	});

	it("names what is missing: a classifier, a registered model, a valid threshold", async () => {
		const none = deps({ classifiers: [] });
		await runEval([], none.value);
		assert.match(none.notices[0]?.[1] ?? "", /No classifier is configured/);
		const gone = deps();
		await runEval(["gone/model"], gone.value);
		assert.match(gone.notices[0]?.[1] ?? "", /not a classifier pi knows/);
		await runEval(["local/judge", "--threshold", "3"], gone.value);
		assert.match(gone.notices.at(-1)?.[1] ?? "", /--threshold must be/);
	});
});
