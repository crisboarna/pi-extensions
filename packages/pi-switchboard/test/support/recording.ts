// Recorded exchanges with a real classifier server. `recordingFetch` wraps the `fetch` the package's own code takes (detect, the System One client) and keeps
// every request and answer, redacted, so one run against a live server can be saved and replayed by `replayFetch` in an ordinary test with no server.
// The recording is the contract: when the server's answers change, the replay test fails on the real bytes, not on a guess about them.
import { homedir } from "node:os";
import { createRedactor } from "../../src/classifier/redact.ts";

export interface Exchange {
	request: { method: string; path: string; body?: unknown };
	response: { status: number; body: string };
}

export interface RecordingMeta {
	/** What answered, as the server names itself (for example llama.cpp). */
	server: string;
	/** The image or build that answered, pinned by digest where there is one. */
	image: string;
	/** The model the classifier requests named. */
	model: string;
	/** The day the recording was made, as YYYY-MM-DD. */
	recordedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What identifies a request when it is replayed: the method and path, and for a classifier request the text it classifies. */
export function keyOf(method: string, path: string, body: unknown): string {
	const state = isRecord(body) && isRecord(body.state) ? body.state : undefined;
	const request = typeof state?.request === "string" ? state.request : "";
	return `${method.toUpperCase()} ${path}${request ? ` :: ${request}` : ""}`;
}

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** A `fetch` that passes every call to `inner` and appends what was asked and answered to `sink`, with the user's home folder, secret-shaped strings and anything matching an `extra` pattern (a regular expression source) masked. */
export function recordingFetch(inner: typeof fetch, sink: Exchange[], extra: string[] = []): typeof fetch {
	const redact = createRedactor({ home: homedir(), extra });
	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const response = await inner(input, init);
		const text = await response.clone().text();
		const body = typeof init?.body === "string" ? parseJson(init.body) : undefined;
		sink.push({
			request: {
				method: (init?.method ?? "GET").toUpperCase(),
				path: `${url.pathname}${url.search}`,
				...(body === undefined ? {} : { body: parseJson(redact(JSON.stringify(body))) }),
			},
			response: { status: response.status, body: redact(text) },
		});
		return response;
	};
}

/** A `fetch` that answers from the recording and throws, naming what is missing, for a request that was not recorded. */
export function replayFetch(exchanges: readonly Exchange[]): typeof fetch {
	const byKey = new Map(exchanges.map((exchange) => [keyOf(exchange.request.method, exchange.request.path, exchange.request.body), exchange]));
	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? parseJson(init.body) : undefined;
		const key = keyOf(method, `${url.pathname}${url.search}`, body);
		const found = byKey.get(key);
		if (!found) throw new Error(`no recording for ${key}; record the server again with test/recordings/record.ts`);
		return new Response(found.response.body, { status: found.response.status, headers: { "content-type": "application/json" } });
	};
}

/** One JSON object per line: the meta first, then each exchange. */
export const toJsonl = (meta: RecordingMeta, exchanges: readonly Exchange[]): string =>
	`${[JSON.stringify({ meta }), ...exchanges.map((exchange) => JSON.stringify(exchange))].join("\n")}\n`;

export function fromJsonl(text: string): { meta: RecordingMeta; exchanges: Exchange[] } {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const first = lines.length > 0 ? parseJson(lines[0] ?? "") : undefined;
	if (!isRecord(first) || !isRecord(first.meta)) throw new Error("a recording starts with a meta line");
	const { server, image, model, recordedAt } = first.meta;
	if (typeof server !== "string" || typeof image !== "string" || typeof model !== "string" || typeof recordedAt !== "string")
		throw new Error("the meta line needs server, image, model and recordedAt");
	const exchanges = lines.slice(1).map((line, index) => {
		const value = parseJson(line);
		if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.response)) throw new Error(`line ${index + 2} is not an exchange`);
		const { method, path, body } = value.request;
		if (typeof method !== "string" || typeof path !== "string" || typeof value.response.status !== "number" || typeof value.response.body !== "string")
			throw new Error(`line ${index + 2} is not an exchange`);
		return { request: { method, path, ...(body === undefined ? {} : { body }) }, response: { status: value.response.status, body: value.response.body } };
	});
	return { meta: { server, image, model, recordedAt }, exchanges };
}
