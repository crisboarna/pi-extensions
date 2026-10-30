import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DynamicRef } from "../../src/core/library.ts";
import { type FetchRequest, type FetchResult, isUrlRef, type UrlEnv, type UrlRef, urlBlock } from "../../src/core/url.ts";

const text = (value: string) => new TextEncoder().encode(value);
const page = (body: string | Uint8Array, extra: Partial<Extract<FetchResult, { killed: false }>> = {}): FetchResult => ({
	killed: false,
	status: 200,
	contentType: "text/plain",
	bytes: typeof body === "string" ? text(body) : body,
	...extra,
});

/** An env whose fetcher answers with `result` (or rejects with it, when it is an Error) and remembers what it was asked. */
function env(result: FetchResult | Error): UrlEnv & { requests: FetchRequest[] } {
	const requests: FetchRequest[] = [];
	return {
		requests,
		fetchUrl: async (request) => {
			requests.push(request);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}
const ref = (extra: Partial<UrlRef> = {}): UrlRef => ({ name: "spec", kind: "dynamic", url: "https://example.com/spec.md", ...extra });

describe("isUrlRef", () => {
	it("is true for a Dynamic Ref with a url only", () => {
		assert.equal(isUrlRef(ref()), true);
		const command: DynamicRef = { name: "c", kind: "dynamic", command: ["ls"] };
		assert.equal(isUrlRef(command), false);
		assert.equal(isUrlRef({ kind: "snippet" }), false);
	});
});

describe("a URL Dynamic Ref", () => {
	it("asks the fetcher for the URL with the default 10 s timeout and 50 KB cap", async () => {
		const e = env(page(""));
		await urlBlock(ref(), e);
		assert.deepEqual(e.requests, [{ name: "spec", url: "https://example.com/spec.md", timeoutMs: 10_000, maxBytes: 51_200 }]);
	});

	it("passes a raised timeout and cap, and the cancel signal", async () => {
		const e = env(page(""));
		const controller = new AbortController();
		await urlBlock(ref({ timeout: 120, max_output: 1024 * 1024 }), e, controller.signal);
		assert.deepEqual(e.requests, [
			{ name: "spec", url: "https://example.com/spec.md", timeoutMs: 120_000, maxBytes: 1_048_576, signal: controller.signal },
		]);
	});

	it("sends the body in a block that names the URL on a line of its own", async () => {
		const block = await urlBlock(ref(), env(page("# Spec\n")));
		assert.equal(
			block.text,
			'<context-ref name="spec" kind="dynamic" source="https://example.com/spec.md" bytes="39">\nGET https://example.com/spec.md\n# Spec\n\n</context-ref>',
		);
		assert.equal("reason" in block, false);
	});

	it("sends an empty body as the URL line alone", async () => {
		const block = await urlBlock(ref(), env(page("")));
		assert.equal(
			block.text,
			'<context-ref name="spec" kind="dynamic" source="https://example.com/spec.md" bytes="31">\nGET https://example.com/spec.md\n</context-ref>',
		);
	});

	it("escapes the URL in the attribute, and strips control characters from the body", async () => {
		const block = await urlBlock(ref({ url: 'https://example.com/?a=1&b="2"' }), env(page("a\u001b[31mb\u0007\n")));
		assert.equal(
			block.text,
			'<context-ref name="spec" kind="dynamic" source="https://example.com/?a=1&amp;b=&quot;2&quot;" bytes="42">\nGET https://example.com/?a=1&b="2"\na[31mb\n\n</context-ref>',
		);
	});

	it("marks a body past the cap as truncated, cut on a character boundary", async () => {
		// The fetcher hands over one byte more than the cap; "ééé" is six bytes and the cap is five, so the cut falls inside the third letter.
		const block = await urlBlock(ref({ max_output: 5 }), env(page("ééé")));
		assert.equal(
			block.text,
			'<context-ref name="spec" kind="dynamic" source="https://example.com/spec.md" bytes="59" truncated="5 bytes">\nGET https://example.com/spec.md (truncated at 5 bytes)\néé\n</context-ref>',
		);
		assert.equal("reason" in block, false);
	});

	it("does not mark a body that is exactly the cap", async () => {
		const block = await urlBlock(ref({ max_output: 4 }), env(page("éé")));
		assert.equal(block.text.includes("truncated"), false);
	});

	it("takes JSON, Markdown, XML, +json types and a missing type as text, and a charset parameter in stride", async () => {
		for (const contentType of ["application/json", "text/markdown", "text/html; charset=utf-8", "APPLICATION/XML", "application/vnd.api+json", undefined]) {
			const block = await urlBlock(ref(), env(page("{}", { contentType })));
			assert.equal("reason" in block, false, String(contentType));
		}
	});

	it("fails on a body of another type, naming the type", async () => {
		for (const contentType of ["image/png", "application/pdf", "application/octet-stream", "application/zip"]) {
			const block = await urlBlock(ref(), env(page("looks like text", { contentType })));
			assert.deepEqual("reason" in block && block.reason, `https://example.com/spec.md answered binary content (${contentType})`);
		}
	});

	it("fails on a body with NUL bytes near the start, whatever its type", async () => {
		for (const contentType of ["text/plain", undefined]) {
			const block = await urlBlock(ref(), env(page(new Uint8Array([80, 75, 3, 4, 0, 1]), { contentType })));
			assert.equal("reason" in block && block.reason, "https://example.com/spec.md answered binary content");
		}
	});

	it("gives a Failure note for a failure", async () => {
		const block = await urlBlock(ref(), env(page(new Uint8Array([0]))));
		assert.equal(
			block.text,
			'<context-ref name="spec" kind="dynamic" source="https://example.com/spec.md" bytes="0" error="https://example.com/spec.md answered binary content">\n\n</context-ref>',
		);
	});

	it("fails on a status outside 200 to 299, naming it", async () => {
		for (const status of [199, 301, 404, 500]) {
			const block = await urlBlock(ref(), env(page("body", { status })));
			assert.equal("reason" in block && block.reason, `https://example.com/spec.md answered HTTP ${status}`);
		}
		assert.equal("reason" in (await urlBlock(ref(), env(page("body", { status: 204 })))), false);
	});

	it("fails with the fetcher's reason when the page cannot be fetched", async () => {
		const block = await urlBlock(ref(), env(new Error("more than 5 redirects")));
		assert.equal("reason" in block && block.reason, "https://example.com/spec.md cannot be fetched: more than 5 redirects");
		const odd = await urlBlock(ref(), { fetchUrl: async () => Promise.reject("plain text") });
		assert.equal("reason" in odd && odd.reason, "https://example.com/spec.md cannot be fetched: plain text");
	});

	it("fails with the timeout when the fetcher stopped the fetch, and with 'cancelled' when the signal was aborted", async () => {
		const timedOut = await urlBlock(ref({ timeout: 3 }), env({ killed: true }));
		assert.equal("reason" in timedOut && timedOut.reason, "https://example.com/spec.md timed out after 3 s");
		const controller = new AbortController();
		controller.abort();
		const cancelled = await urlBlock(ref(), env({ killed: true }), controller.signal);
		assert.equal("reason" in cancelled && cancelled.reason, "https://example.com/spec.md was cancelled");
	});
});
