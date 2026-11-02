// The helper that records and replays a classifier server's answers has to be exact, or the contract test built on it proves nothing: what it saves must
// be what was asked and answered with secrets masked, what it replays must be what was saved, and a request nobody recorded must fail loudly.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import { type Exchange, fromJsonl, keyOf, type RecordingMeta, recordingFetch, replayFetch, toJsonl } from "../support/recording.ts";

const META: RecordingMeta = { server: "llama.cpp", image: "example/server@sha256:abc", model: "m1", recordedAt: "2026-11-02" };

describe("recordingFetch", () => {
	it("passes the answer through unchanged and keeps what was asked and answered", async () => {
		const sink: Exchange[] = [];
		const inner: typeof fetch = async () => new Response('{"ok":true}', { status: 200 });
		const response = await recordingFetch(inner, sink)("http://127.0.0.1:8080/v1/systemone?x=1", {
			method: "post",
			body: JSON.stringify({ state: { request: "hello" } }),
		});
		assert.equal(await response.text(), '{"ok":true}', "the caller can still read the body");
		assert.deepEqual(sink, [
			{ request: { method: "POST", path: "/v1/systemone?x=1", body: { state: { request: "hello" } } }, response: { status: 200, body: '{"ok":true}' } },
		]);
	});

	it("keeps a request with no body as a GET with no body, and an error status as it came", async () => {
		const sink: Exchange[] = [];
		await recordingFetch(async () => new Response("nope", { status: 503 }), sink)("http://x.test/v1/models");
		assert.deepEqual(sink[0], { request: { method: "GET", path: "/v1/models" }, response: { status: 503, body: "nope" } });
	});

	it("masks the home folder and anything matching a pattern given, in the request and in the answer", async () => {
		const sink: Exchange[] = [];
		const home = homedir();
		const inner: typeof fetch = async () => new Response(`{"path":"${home}/work","token":"s3cr3t-value"}`);
		await recordingFetch(inner, sink, ["s3cr3t-value"])("http://x.test/a", {
			method: "POST",
			body: JSON.stringify({ file: `${home}/x`, key: "s3cr3t-value" }),
		});
		const saved = JSON.stringify(sink);
		assert.ok(!saved.includes(home), "the home folder is masked");
		assert.ok(!saved.includes("s3cr3t-value"), "the secret is masked");
	});
});

describe("replayFetch", () => {
	const exchanges: Exchange[] = [
		{ request: { method: "GET", path: "/v1/models" }, response: { status: 200, body: '{"data":[]}' } },
		{ request: { method: "POST", path: "/v1/systemone", body: { state: { request: "rename" } } }, response: { status: 200, body: '{"which":"rename"}' } },
		{ request: { method: "POST", path: "/v1/systemone", body: { state: { request: "design" } } }, response: { status: 200, body: '{"which":"design"}' } },
	];

	it("answers each request with the answer recorded for it, telling classifier requests apart by their text", async () => {
		const replay = replayFetch(exchanges);
		assert.equal(await (await replay("http://x.test/v1/models")).text(), '{"data":[]}');
		const one = await replay("http://x.test/v1/systemone", { method: "POST", body: JSON.stringify({ state: { request: "design" } }) });
		assert.equal(await one.text(), '{"which":"design"}');
		const other = await replay("http://x.test/v1/systemone", { method: "POST", body: JSON.stringify({ state: { request: "rename" } }) });
		assert.equal(await other.text(), '{"which":"rename"}');
		assert.equal(one.status, 200);
	});

	it("keeps the recorded status", async () => {
		const replay = replayFetch([{ request: { method: "GET", path: "/down" }, response: { status: 503, body: "loading" } }]);
		assert.equal((await replay("http://x.test/down")).status, 503);
	});

	it("throws for a request nobody recorded, and says how to fix it", async () => {
		const replay = replayFetch(exchanges);
		await assert.rejects(replay("http://x.test/v1/other"), /no recording for GET \/v1\/other; record the server again/);
		await assert.rejects(
			replay("http://x.test/v1/systemone", { method: "POST", body: JSON.stringify({ state: { request: "unseen" } }) }),
			/no recording for POST \/v1\/systemone :: unseen/,
		);
	});
});

describe("keyOf", () => {
	it("uses the method and path, and for a classifier request the text it classifies", () => {
		assert.equal(keyOf("get", "/v1/models", undefined), "GET /v1/models");
		assert.equal(keyOf("post", "/v1/systemone", { state: { request: "a b" } }), "POST /v1/systemone :: a b");
		assert.equal(keyOf("post", "/x", { state: {} }), "POST /x");
		assert.equal(keyOf("post", "/x", "text"), "POST /x");
	});
});

describe("the recording file", () => {
	const exchanges: Exchange[] = [
		{ request: { method: "GET", path: "/v1/models" }, response: { status: 200, body: "{}" } },
		{ request: { method: "POST", path: "/v1/systemone", body: { state: { request: "x" } } }, response: { status: 200, body: "{}" } },
	];

	it("saves one object per line, meta first, and reads back what it saved", () => {
		const text = toJsonl(META, exchanges);
		assert.equal(text.trim().split("\n").length, 3);
		assert.deepEqual(JSON.parse(text.split("\n")[0] ?? ""), { meta: META });
		assert.deepEqual(fromJsonl(text), { meta: META, exchanges });
	});

	it("refuses a file with no meta line, an incomplete meta, or a line that is not an exchange", () => {
		assert.throws(() => fromJsonl(""), /starts with a meta line/);
		assert.throws(() => fromJsonl(`${JSON.stringify(exchanges[0])}\n`), /starts with a meta line/);
		assert.throws(() => fromJsonl(`${JSON.stringify({ meta: { server: "s" } })}\n`), /needs server, image, model and recordedAt/);
		assert.throws(() => fromJsonl(`${toJsonl(META, [])}{"request":{"method":"GET"}}\n`), /line 2 is not an exchange/);
		assert.throws(() => fromJsonl(`${toJsonl(META, [])}not json\n`), /line 2 is not an exchange/);
	});
});
