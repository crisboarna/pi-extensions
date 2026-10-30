import { contextBlock, failureNote, sanitizeText } from "./context-block.ts";
import { BINARY_PROBE_LENGTH, type BlockResult, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_SECONDS, headBytes, sizeText } from "./dynamic.ts";
import type { DynamicRef } from "./library.ts";

/** A Dynamic Ref whose Source is a URL. */
export type UrlRef = DynamicRef & { url: string };

/** What one fetch asks of the fetcher. The fetcher reads at most `maxBytes + 1` bytes of the body, so the caller can tell a body that was cut. */
export interface FetchRequest {
	name: string;
	url: string;
	timeoutMs: number;
	maxBytes: number;
	signal?: AbortSignal;
}

/** What a fetch left behind. `killed` is set when the fetcher stopped it, after a timeout or an abort. */
export type FetchResult = { killed: true } | { killed: false; status: number; contentType: string | undefined; bytes: Uint8Array };

/** What fetching a URL needs from outside. The fetcher rejects when the page cannot be fetched (no connection, too many redirects), with the reason as the message. */
export interface UrlEnv {
	fetchUrl: (request: FetchRequest) => Promise<FetchResult>;
}

export const isUrlRef = (ref: { kind: string; url?: string }): ref is UrlRef => ref.kind === "dynamic" && ref.url !== undefined;

// Types whose body is text although they are not `text/*`.
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|ecmascript|x-ndjson|yaml|x-yaml|toml)$|.+\+(json|xml|yaml)$)/;

/** A URL Ref's Failure note and the reason. */
export function urlFailure(ref: UrlRef, reason: string): BlockResult {
	return { name: ref.name, reason, text: failureNote({ name: ref.name, kind: "dynamic", source: ref.url, error: reason }) };
}

/** GETs the Ref's URL and builds its Context block. A cut is marked in the block; the other ways to fail give a Failure note. */
export async function urlBlock(ref: UrlRef, env: UrlEnv, signal?: AbortSignal): Promise<BlockResult> {
	const source = ref.url;
	const fail = (reason: string): BlockResult => urlFailure(ref, reason);

	const timeout = ref.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	const cap = ref.max_output ?? DEFAULT_MAX_OUTPUT;
	let result: FetchResult;
	try {
		result = await env.fetchUrl({ name: ref.name, url: source, timeoutMs: timeout * 1000, maxBytes: cap, ...(signal ? { signal } : {}) });
	} catch (error) {
		return fail(`${source} cannot be fetched: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (result.killed) return fail(signal?.aborted ? `${source} was cancelled` : `${source} timed out after ${timeout} s`);
	if (result.status < 200 || result.status > 299) return fail(`${source} answered HTTP ${result.status}`);

	const mediaType = result.contentType?.split(";")[0]?.trim().toLowerCase();
	const textual = mediaType === undefined || mediaType === "" || TEXT_TYPE.test(mediaType);
	if (!textual || result.bytes.subarray(0, BINARY_PROBE_LENGTH).includes(0))
		return fail(`${source} answered binary content${textual ? "" : ` (${mediaType})`}`);

	const { bytes, cut } = headBytes(result.bytes, cap);
	const truncated = cut ? sizeText(cap) : undefined;
	const line = `GET ${source}${truncated === undefined ? "" : ` (truncated at ${truncated})`}`;
	const text = sanitizeText(bytes);
	return {
		name: ref.name,
		text: contextBlock({
			name: ref.name,
			kind: "dynamic",
			source,
			body: text === "" ? line : `${line}\n${text}`,
			...(truncated === undefined ? {} : { truncated }),
		}),
	};
}
