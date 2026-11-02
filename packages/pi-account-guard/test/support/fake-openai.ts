// A stand-in for an OpenAI-compatible server, so real pi can run a whole turn through its own OpenAI client with no network and no key, and a test can read
// the request bodies that really left pi. It answers POST /v1/chat/completions as a stream (what pi asks for) or as one JSON body, and keeps every request.
// This file is the same in every package that has it (scripts/checks/copies.ts); change it in all of them.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_PROVIDER = "fakeai";
export const FAKE_MODEL = "fake-model";
export const FAKE_REPLY = "FAKE-SERVER-REPLY";

export interface WireRequest {
	method: string;
	path: string;
	/** The parsed JSON body, or the raw text when it was not JSON. */
	body: unknown;
}

export interface FakeOpenAI {
	/** The address to put in a provider's `baseUrl`, with the `/v1` root. */
	baseUrl: string;
	/** Every request that reached the server, in order. */
	requests: WireRequest[];
	/** The chat completion requests only: the turns that were sent. */
	completions(): WireRequest[];
	close(): Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		let text = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			text += chunk;
		});
		request.on("end", () => resolve(text));
		request.on("error", reject);
	});

const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
	id: "chatcmpl-fake",
	object: "chat.completion.chunk",
	created: 1,
	model: FAKE_MODEL,
	choices: [{ index: 0, delta, finish_reason: finish }],
});

/** Starts the server on a free port of 127.0.0.1. `reply` is what it answers every turn with. */
export async function startFakeOpenAI(reply: string = FAKE_REPLY): Promise<FakeOpenAI> {
	const requests: WireRequest[] = [];
	const server: Server = createServer(async (request, response) => {
		const path = request.url ?? "/";
		const body = parse(await readBody(request));
		requests.push({ method: request.method ?? "GET", path, body });
		if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
			response
				.writeHead(404, { "content-type": "application/json" })
				.end(JSON.stringify({ error: { message: `no route for ${request.method} ${path}` } }));
			return;
		}
		const streaming = typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
		if (!streaming) {
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					id: "chatcmpl-fake",
					object: "chat.completion",
					created: 1,
					model: FAKE_MODEL,
					choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
		send(chunk({ role: "assistant", content: "" }, null));
		send(chunk({ content: reply }, null));
		send({ ...chunk({}, "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		completions: () => requests.filter((request) => request.method === "POST" && request.path.endsWith("/chat/completions")),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** The `models.json` that makes pi talk to the server: an OpenAI-compatible provider with a dummy key, which the server ignores. */
export const modelsJson = (baseUrl: string): string =>
	JSON.stringify({ providers: { [FAKE_PROVIDER]: { baseUrl, api: "openai-completions", apiKey: "not-a-secret", models: [{ id: FAKE_MODEL }] } } });
