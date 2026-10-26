// A stand-in for a local System One decision server (LM Studio's /v1/systemone):
// same request and response shape as H2O-Lightning-4B, with answers scripted
// per scene. Only the answers are scripted; pi-switchboard's rules, gates,
// tiers and strategies decide everything else as they would live.
import { createServer, type Server } from "node:http";

export interface ScriptedAnswer {
	/** Substring of the classified text that selects this answer. */
	match: string;
	work: string;
	confidence: number;
	/** 0 shallow, 1 moderate, 2 deep. */
	depth: number;
	/** Probability that a mistake would be costly. */
	risky: number;
}

const FALLBACK: ScriptedAnswer = { match: "", work: "implement", confidence: 0.88, depth: 1, risky: 0.1 };

interface WireQuestion {
	type: string;
	criteria?: Record<string, string> | string[];
}

function answer(question: WireQuestion, id: string, scripted: ScriptedAnswer): unknown {
	if (question.type === "choice") {
		const labels = Object.keys(question.criteria ?? {});
		const rest = (1 - scripted.confidence) / Math.max(1, labels.length - 1);
		const probabilities = Object.fromEntries(labels.map((label) => [label, label === scripted.work ? scripted.confidence : rest]));
		return { type: "choice", choice: scripted.work, probabilities, confidence: scripted.confidence };
	}
	if (question.type === "score") return { type: "score", score: scripted.depth, confidence: 0.8 };
	return { type: "noul", noul: id === "ready" ? 0.93 : scripted.risky };
}

export function startClassifier(script: ScriptedAnswer[]): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (data) => (body += data));
		req.on("end", () => {
			const request = JSON.parse(body || "{}") as { model?: string; state?: Record<string, unknown>; questions?: Record<string, WireQuestion> };
			const text = JSON.stringify(request.state ?? {});
			const scripted = script.find((entry) => text.includes(entry.match)) ?? FALLBACK;
			const answers = Object.fromEntries(Object.entries(request.questions ?? {}).map(([id, question]) => [id, answer(question, id, scripted)]));
			// A local model answers in a few hundred milliseconds.
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ model: request.model, answers, usage: { input_tokens: 280, output_tokens: 0 } }));
			}, 260);
		});
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`, server })),
	);
}
