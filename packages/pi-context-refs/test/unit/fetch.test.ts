import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isLocalHost, urlEnv } from "../../src/pi/fetch.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** A fetch that answers from a table of URL to response and records the URLs it was asked for. */
function serve(pages: Record<string, Response>): string[] {
	const asked: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		asked.push(url);
		const page = pages[url];
		if (!page) throw new Error(`unexpected ${url}`);
		return page;
	}) as typeof fetch;
	return asked;
}
const publicNames = async (): Promise<string[]> => ["93.184.216.34"];
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const request = (url: string) => ({ name: "page", url, timeoutMs: 5000, maxBytes: 1000 });

describe("isLocalHost", () => {
	it("is true for loopback, private, link-local and unspecified addresses and for localhost names", () => {
		for (const host of [
			"localhost",
			"app.localhost",
			"127.0.0.1",
			"127.8.8.8",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"0.0.0.0",
			"100.64.0.1",
			"100.127.255.255",
			"198.18.0.1",
			"198.19.255.255",
			"localhost.",
			"app.localhost.",
		])
			assert.equal(isLocalHost(host), true, host);
		for (const host of [
			"[::1]",
			"[::]",
			"[fc00::1]",
			"[fd12:3456::1]",
			"[fe80::1]",
			"[::ffff:127.0.0.1]",
			"[64:ff9b::7f00:1]",
			"[64:ff9b::169.254.169.254]",
		])
			assert.equal(isLocalHost(host), true, host);
	});

	it("is false for public hosts and addresses", () => {
		for (const host of [
			"example.com",
			"8.8.8.8",
			"172.32.0.1",
			"172.15.0.1",
			"192.169.0.1",
			"100.63.0.1",
			"100.128.0.1",
			"198.20.0.1",
			"[2606:4700::1111]",
			"[64:ff9b::808:808]",
			"localhost.example.com",
		])
			assert.equal(isLocalHost(host), false, host);
	});
});

describe("a redirect", () => {
	it("from a public host to a loopback, private or link-local address is refused, and the address is not fetched", async () => {
		for (const target of [
			"http://127.0.0.1:8080/x",
			"http://169.254.169.254/latest/meta-data",
			"http://192.168.0.1/",
			"http://localhost/",
			"http://[::1]/",
		]) {
			const asked = serve({ "https://example.com/start": redirect(target) });
			await assert.rejects(urlEnv(publicNames).fetchUrl(request("https://example.com/start")), /local or private address/, target);
			assert.deepEqual(asked, ["https://example.com/start"], target);
		}
	});

	it("between public hosts is followed", async () => {
		serve({ "https://example.com/a": redirect("https://other.example.org/b"), "https://other.example.org/b": new Response("ok", { status: 200 }) });
		const result = await urlEnv(publicNames).fetchUrl(request("https://example.com/a"));
		assert.equal(result.killed, false);
	});

	it("to a name that resolves to a local or private address is refused, and the name is not fetched", async () => {
		for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "::1", "100.64.0.9"]) {
			const asked = serve({ "https://example.com/start": redirect("https://metadata.example.net/x") });
			await assert.rejects(
				urlEnv(async () => ["93.184.216.34", address]).fetchUrl(request("https://example.com/start")),
				/resolves to a local or private address/,
				address,
			);
			assert.deepEqual(asked, ["https://example.com/start"], address);
		}
	});

	it("to a name that cannot be looked up is followed, and the fetch itself then fails or not", async () => {
		serve({ "https://example.com/a": redirect("https://gone.example.net/b"), "https://gone.example.net/b": new Response("ok", { status: 200 }) });
		const result = await urlEnv(async () => []).fetchUrl(request("https://example.com/a"));
		assert.equal(result.killed, false);
	});

	it("from https to http is refused, because the page could be changed on the way", async () => {
		const asked = serve({ "https://example.com/a": redirect("http://other.example.org/b") });
		await assert.rejects(urlEnv(publicNames).fetchUrl(request("https://example.com/a")), /from https to http/);
		assert.deepEqual(asked, ["https://example.com/a"]);
	});

	it("is followed when the Ref's own URL is already local, because the person approved that host", async () => {
		serve({ "http://127.0.0.1:9/a": redirect("http://127.0.0.1:9/b"), "http://127.0.0.1:9/b": new Response("ok", { status: 200 }) });
		const result = await urlEnv(publicNames).fetchUrl(request("http://127.0.0.1:9/a"));
		assert.equal(result.killed, false);
	});
});
