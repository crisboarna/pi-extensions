// A stand-in System One classifier for the end-to-end suites: an HTTP server in
// the test process on 127.0.0.1, which pi-switchboard reaches through a
// `classifierProviders` entry. It answers `POST /v1/systemone` as
// src/classifier/system-one.ts reads it, from a queue the test fills: an
// answer, a refused connection, a request left hanging, or a late answer. It
// keeps every request body, so a test can check what reached the classifier.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** What the classifier answers; questions it does not name get a plain, confident default. */
export interface Answer {
	/** Choice answers by question id, such as `{ work: "review" }`. */
	choices?: Record<string, string>;
	/** The confidence of every choice answer; default 0.95. */
	confidence?: number;
	/** Score answers by question id, such as `{ depth: 1 }`. */
	scores?: Record<string, number>;
	/** Yes/no answers by question id, as the probability of yes, such as `{ risky: 0.05 }`. */
	bools?: Record<string, number>;
}

/** One queued reply: an answer, a connection closed with no response, no response at all, or an answer after `delayMs`. */
export type Reply = Answer | { refuse: true } | { hang: true } | { delayMs: number; answer?: Answer };

/** A request as the classifier received it. */
export interface Received {
	model: string;
	state: { scope?: string; request?: string; [key: string]: unknown };
	questions: Record<string, { type: string; criteria?: unknown }>;
}

/** The default for anything not queued: implement, depth 1, not risky, all confident. */
const PLAIN: Answer = { choices: { work: "implement" }, scores: { depth: 1 }, bools: { risky: 0.05 } };

function answerFor(questions: Received["questions"], answer: Answer): Record<string, unknown> {
	const confidence = answer.confidence ?? 0.95;
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(questions)) {
		if (question.type === "choice") {
			const options = Object.keys((question.criteria ?? {}) as Record<string, string>);
			const choice = answer.choices?.[id] ?? PLAIN.choices?.[id] ?? options[0] ?? "";
			const rest = (1 - confidence) / Math.max(options.length - 1, 1);
			answers[id] = { type: "choice", choice, confidence, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? confidence : rest])) };
		} else if (question.type === "score") answers[id] = { type: "score", score: answer.scores?.[id] ?? PLAIN.scores?.[id] ?? 0, confidence };
		else answers[id] = { type: "noul", noul: answer.bools?.[id] ?? PLAIN.bools?.[id] ?? (id === "ready" ? 0.99 : 0.05) };
	}
	return { answers, usage: { input_tokens: 100, output_tokens: 0 } };
}

export class StandinClassifier {
	/** Every request but the warm-up's, in order. */
	readonly requests: Received[] = [];
	readonly #server: Server;
	readonly #queue: Reply[] = [];
	readonly #when: Array<{ pattern: RegExp; reply: Reply }> = [];
	readonly #hanging = new Set<ServerResponse>();
	readonly #sockets = new Set<Socket>();

	private constructor(server: Server) {
		this.#server = server;
		server.on("connection", (socket) => {
			this.#sockets.add(socket);
			socket.on("close", () => this.#sockets.delete(socket));
		});
		server.on("request", (request, response) => void this.#handle(request, response));
	}

	static async start(): Promise<StandinClassifier> {
		const server = createServer();
		await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
		return new StandinClassifier(server);
	}

	/** The base URL for a `classifierProviders` entry. */
	get baseUrl(): string {
		return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1/`;
	}

	/** Queues replies for the next requests, after which the default answer applies again. */
	reply(...replies: Reply[]): void {
		this.#queue.push(...replies);
	}

	/** Answers every request whose text matches `pattern` with `reply`, before the queue: parallel requests arrive in any order. */
	when(pattern: RegExp, reply: Reply): void {
		this.#when.push({ pattern, reply });
	}

	/** Forgets queued replies, `when` rules and received requests, between tests. */
	reset(): void {
		this.#queue.length = 0;
		this.#when.length = 0;
		this.requests.length = 0;
	}

	async close(): Promise<void> {
		for (const response of this.#hanging) response.destroy();
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((closed) => this.#server.close(() => closed()));
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let body = "";
		for await (const chunk of request) body += String(chunk);
		const received = JSON.parse(body || "{}") as Received;
		const send = (answer: Answer) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(answerFor(received.questions ?? {}, answer)));
		};
		// pi-switchboard's warm-up at session start and /tier doctor's probe ask one question, `ready`.
		if (received.state?.request === "warm-up") return send({});
		this.requests.push(received);
		const text = String(received.state?.request ?? "");
		const reply = this.#when.find(({ pattern }) => pattern.test(text))?.reply ?? this.#queue.shift() ?? {};
		if ("refuse" in reply) response.socket?.destroy();
		else if ("hang" in reply) this.#hanging.add(response);
		else if ("delayMs" in reply) setTimeout(() => send(reply.answer ?? {}), reply.delayMs);
		else send(reply);
	}
}
