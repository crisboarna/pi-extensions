import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchRequest, FetchResult, UrlEnv } from "../core/url.ts";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Every address a host name has; empty when it cannot be looked up. */
export type ResolveHost = (host: string) => Promise<string[]>;

const addressesOf: ResolveHost = async (host) => {
	try {
		return (await lookup(host, { all: true })).map((entry) => entry.address);
	} catch {
		return [];
	}
};

/** Fetches a URL with a plain GET: no headers of ours, up to 5 redirects, and at most `maxBytes + 1` bytes of the body. `resolve` looks up the names redirects point to. */
export function urlEnv(resolve: ResolveHost = addressesOf): UrlEnv {
	return { fetchUrl: (request) => fetchUrl(request, resolve) };
}

async function fetchUrl(request: FetchRequest, resolve: ResolveHost): Promise<FetchResult> {
	const timeout = AbortSignal.timeout(request.timeoutMs);
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
	try {
		const response = await followRedirects(request.url, signal, resolve);
		const bytes = await readHead(response, request.maxBytes + 1);
		return { killed: false, status: response.status, contentType: response.headers.get("content-type") ?? undefined, bytes };
	} catch (error) {
		// An abort and a timeout stop the fetch from outside: the caller tells them apart by its own signal.
		if (signal.aborted) return { killed: true };
		throw new Error(reasonOf(error));
	}
}

/** The final response; each redirect is followed by hand so the count is ours and the target must be http or https. */
async function followRedirects(url: string, signal: AbortSignal, resolve: ResolveHost): Promise<Response> {
	let current = url;
	for (let redirects = 0; ; redirects++) {
		const response = await fetch(current, { redirect: "manual", signal });
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
		await response.body?.cancel();
		if (redirects === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
		const next = URL.parse(location, current);
		if (next?.protocol !== "http:" && next?.protocol !== "https:") throw new Error(`redirected to ${location}, which is not an http or https URL`);
		const from = URL.parse(current);
		// The person approved the Ref's own host; a redirect must not lead from a public one to a local one, and a page fetched over https must not be sent on over http.
		const startedLocal = isLocalHost(from?.hostname ?? "");
		if (!startedLocal) {
			if (isLocalHost(next.hostname)) throw new Error(`redirected to ${next.hostname}, a local or private address`);
			if (from?.protocol === "https:" && next.protocol === "http:") throw new Error(`redirected from https to http (${next.href})`);
			if (isIP(next.hostname.replace(/^\[|\]$/g, "")) === 0 && (await resolve(next.hostname)).some(isLocalAddress))
				throw new Error(`redirected to ${next.hostname}, which resolves to a local or private address`);
		}
		current = next.href;
	}
}

/** Whether an address a name resolved to is local or private. */
function isLocalAddress(address: string): boolean {
	return isLocalHost(address.includes(":") ? `[${address}]` : address);
}

/** Whether a host name is this machine or a private network: `localhost`, and an address that is loopback, private, shared (carrier-grade NAT), link-local or unspecified. A name is judged by its text only; `resolve` is for the names redirects point to. */
export function isLocalHost(host: string): boolean {
	const name = host.toLowerCase().replace(/\.$/, "");
	if (name === "localhost" || name.endsWith(".localhost")) return true;
	if (name.startsWith("[")) return isLocalIpv6(name.slice(1, -1));
	return isLocalIpv4(name.split(".").map(Number));
}

function isLocalIpv4(octets: number[]): boolean {
	const [a, b] = octets;
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)) || a === undefined || b === undefined) return false;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function isLocalIpv6(address: string): boolean {
	if (address === "::" || address === "::1") return true;
	if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return true;
	const mapped = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(address);
	if (!mapped) return false;
	if (mapped[1] !== undefined) return isLocalIpv4(mapped[1].split(".").map(Number));
	const high = Number.parseInt(mapped[2] ?? "", 16);
	const low = Number.parseInt(mapped[3] ?? "", 16);
	return isLocalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
}

/** The first `limit` bytes of the body; the rest is not downloaded. */
async function readHead(response: Response, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = response.body?.getReader();
	while (reader && length < limit) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		length += value.length;
	}
	await reader?.cancel();
	return Buffer.concat(chunks).subarray(0, limit);
}

/** Node reports most network errors as "fetch failed" with the real reason in `cause`. */
function reasonOf(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause instanceof Error ? error.cause.message : undefined;
	return cause ?? error.message;
}
