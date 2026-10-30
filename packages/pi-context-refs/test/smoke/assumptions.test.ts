// Opt-in: runs real pi (`npm run test:smoke`). One test per assumption in DESIGN.md section 16.1
// that pi's non-interactive modes can show; the TUI ones are in assumptions-tui.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RpcRecord, RpcSession, runPrint } from "../support/pi-process.ts";
import { PROBE_BODY, probeBlock } from "../support/probe-extension.ts";
import { probeRun } from "../support/probe-run.ts";
import { REPLY_PREFIX, replyFor } from "../support/stub-provider.ts";

const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;
const isResponse = (id: string) => (record: RpcRecord) => record.type === "response" && record.id === id;
const withBlock = (text: string) => `${text}\n\n${probeBlock()}`;

describe("an input rewrite reaches the model (DESIGN.md section 8)", () => {
	it("in print mode, with the images the handler attached", async () => {
		const run = probeRun("rewrite-image");
		const result = await runPrint("hello", run.options);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), replyFor({ text: withBlock("hello"), images: 1 }));
		assert.deepEqual(run.received(), [{ text: withBlock("hello"), images: 1 }]);
		assert.ok(result.stdout.includes(PROBE_BODY));
	});

	it("in RPC mode, for a prompt, a steer and a follow-up", async () => {
		const run = probeRun("rewrite", { STUB_DELAY_MS: "700" });
		const rpc = new RpcSession(run.options);
		try {
			rpc.send({ id: "p1", type: "prompt", message: "first" });
			await rpc.waitFor((record) => record.type === "agent_start");
			rpc.send({ id: "s1", type: "steer", message: "second" });
			rpc.send({ id: "f1", type: "follow_up", message: "third" });
			assert.deepEqual((await rpc.waitFor(isResponse("s1"))).data, { disposition: "queued" });
			assert.deepEqual((await rpc.waitFor(isResponse("f1"))).data, { disposition: "queued" });
			await rpc.waitFor((record) => record.type === "agent_settled", 60_000);
			assert.deepEqual(
				run.received().map((received) => received.text),
				["first", "second", "third"].map(withBlock),
				"every message the model received carries its rewrite",
			);
			const inputs = run.observations().filter((entry) => entry.ran === "input");
			assert.deepEqual(
				inputs.map((entry) => [entry.text, entry.source, entry.streamingBehavior]),
				[
					["first", "rpc", undefined],
					["second", "rpc", "steer"],
					["third", "rpc", "followUp"],
				],
				"the input event fires for the steer and the follow-up, saying how each is delivered",
			);
			assert.ok(JSON.stringify(rpc.records).includes(REPLY_PREFIX));
		} finally {
			await rpc.close();
		}
	});
});

describe("ctx.ui.confirm (DESIGN.md section 10.3)", () => {
	it("is false when there is no UI", async () => {
		const run = probeRun("confirm");
		const result = await runPrint("hello", run.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(run.observations(), [{ ran: "input", hasUI: false, confirm: false }]);
	});

	it("reaches the RPC client, which answers with extension_ui_response", async () => {
		const run = probeRun("confirm");
		const rpc = new RpcSession(run.options);
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const request = await rpc.waitFor(isUiRequest("confirm"));
			assert.equal(request.title, "Probe approval");
			assert.equal(request.message, "Run the probe?");
			assert.ok(!rpc.records.some((record) => record.type === "agent_start"), "the turn waits for the answer");
			rpc.send({ type: "extension_ui_response", id: request.id, confirmed: true });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(run.observations(), [{ ran: "input", hasUI: true, confirm: true }]);
		} finally {
			await rpc.close();
		}
	});

	it("is false in RPC when the client declines", async () => {
		const run = probeRun("confirm");
		const rpc = new RpcSession(run.options);
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const request = await rpc.waitFor(isUiRequest("confirm"));
			rpc.send({ type: "extension_ui_response", id: request.id, confirmed: false });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(run.observations(), [{ ran: "input", hasUI: true, confirm: false }]);
		} finally {
			await rpc.close();
		}
	});
});

describe("extension commands (DESIGN.md section 14)", () => {
	it("run in print mode with their arguments and send no turn to the model", async () => {
		const run = probeRun("command");
		const result = await runPrint("/ref add api file src/api.ts desc=the api", run.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(run.observations(), [{ ran: "command", args: "add api file src/api.ts desc=the api", hasUI: false }]);
		assert.deepEqual(run.received(), []);
		assert.equal(result.stdout, "");
	});

	it("show nothing through ctx.ui.notify in print mode; direct writes reach stderr, never stdout", async () => {
		const run = probeRun("command");
		const result = await runPrint("/ref list", run.options);
		assert.equal(result.stdout, "", "stdout stays empty");
		assert.equal(result.stderr, "probe stdout write\nprobe stderr write\n", "notify is silent; stdout writes are redirected to stderr");
	});

	it("reach an RPC client through ctx.ui.notify", async () => {
		const run = probeRun("command");
		const rpc = new RpcSession(run.options);
		try {
			rpc.send({ id: "p1", type: "prompt", message: "/ref list" });
			const notice = await rpc.waitFor(isUiRequest("notify"));
			assert.equal(notice.message, "probe notice for list");
			assert.equal(notice.notifyType, "info");
		} finally {
			await rpc.close();
		}
	});
});
