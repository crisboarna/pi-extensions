// Opt-in: runs real pi (`npm run test:smoke`). One test per assumption in DESIGN.md section 17.1.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RpcSession, runPrint, type PiOptions, type RpcRecord } from "../support/pi-process.ts";
import { STUB_MODEL, STUB_MODEL_2, STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";

const PROBE_EXTENSION = join(import.meta.dirname, "..", "support", "probe-extension.ts");

interface Probe {
	options: PiOptions;
	/** Observations the probe extension wrote, in order. */
	observations(): Array<Record<string, unknown>>;
	/** Model ids of the requests that reached the stub provider, in order. */
	requests(): string[];
}

function probe(scenario: string): Probe {
	const dir = mkdtempSync(join(tmpdir(), "account-guard-probe-"));
	const log = join(dir, "probe.jsonl");
	const requestLog = join(dir, "requests.txt");
	const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
	return {
		options: { extensions: [PROBE_EXTENSION], env: { PROBE_SCENARIO: scenario, PROBE_LOG: log, STUB_REQUEST_LOG: requestLog } },
		observations: () => lines(log).map((line) => JSON.parse(line)),
		requests: () => lines(requestLog),
	};
}

const mentionsReply = (records: RpcRecord[]) => records.some((record) => JSON.stringify(record).includes(STUB_REPLY));
const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;

/** Stop reason and error text of every assistant message in the session. */
async function assistantOutcomes(rpc: RpcSession): Promise<Array<{ stopReason: unknown; errorMessage: unknown }>> {
	const id = `messages-${rpc.records.length}`;
	rpc.send({ id, type: "get_messages" });
	const response = await rpc.waitFor((record) => record.type === "response" && record.id === id);
	const messages = (response.data as { messages: Array<Record<string, unknown>> }).messages;
	return messages.filter((message) => message.role === "assistant").map(({ stopReason, errorMessage }) => ({ stopReason, errorMessage }));
}

async function withRpc(scenario: string, body: (rpc: RpcSession, observed: Probe) => Promise<void>): Promise<void> {
	const observed = probe(scenario);
	const rpc = new RpcSession(observed.options);
	try {
		await body(rpc, observed);
	} finally {
		await rpc.close();
	}
}

describe("assumed pi behaviour (DESIGN.md section 17.1)", () => {
	it("a throwing handler lets the turn continue", async () => {
		const observed = probe("throwing-handlers");
		const result = await runPrint("hello", observed.options);
		assert.deepEqual(observed.observations(), [{ ran: "input" }, { ran: "before_agent_start" }]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
		assert.match(result.stderr, /Extension error \(.*probe-extension\.ts\): probe: input handler throws/);
		assert.match(result.stderr, /Extension error \(.*probe-extension\.ts\): probe: before_agent_start handler throws/);
	});

	it("input can await a dialog and then continue", async () => {
		await withRpc("input-dialog", async (rpc, observed) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const dialog = await rpc.waitFor(isUiRequest("select"));
			assert.equal(dialog.title, "Probe dialog");
			assert.ok(!rpc.records.some((record) => record.type === "agent_start"), "the turn waits for the dialog");
			rpc.send({ type: "extension_ui_response", id: dialog.id, value: "Go" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.ok(mentionsReply(rpc.records), "the turn ran after the dialog was answered");
			assert.deepEqual(observed.observations(), [{ ran: "input", choice: "Go" }]);
		});
	});

	it("input returning handled plus setEditorText refills the editor and sends no turn", async () => {
		await withRpc("input-handled-refill", async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const response = await rpc.waitFor((record) => record.type === "response" && record.id === "p1");
			assert.equal(response.success, true);
			assert.deepEqual(response.data, { disposition: "handled" });
			const refill = await rpc.waitFor(isUiRequest("set_editor_text"));
			assert.equal(refill.text, "hello");
			assert.ok(!rpc.records.some((record) => record.type === "agent_start"), "no turn started");
			assert.ok(!mentionsReply(rpc.records));
		});
	});

	it("ctx.abort() works from model_select mid-turn", async () => {
		await withRpc("abort-from-model-select", async (rpc, observed) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(observed.observations(), [
				{ ran: "model_select", idle: false, eventModel: STUB_MODEL_2, ctxModel: STUB_MODEL_2, source: "set" },
				{ switched: true },
			]);
			assert.ok(!mentionsReply(rpc.records), "the stub reply never arrived");
			assert.deepEqual(observed.requests(), [], "no request reached the provider after the abort");
			assert.deepEqual(await assistantOutcomes(rpc), [{ stopReason: "error", errorMessage: "This operation was aborted" }]);
		});
	});

	it("process.exitCode = 77 survives pi -p", async () => {
		const result = await runPrint("hello", probe("exit-77").options);
		assert.equal(result.code, 77);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "probe: blocked\n");
	});

	it("setStatus is visible in RPC", async () => {
		await withRpc("status", async (rpc) => {
			const status = await rpc.waitFor(isUiRequest("setStatus"));
			assert.equal(status.statusKey, "guard");
			assert.equal(status.statusText, "probe status");
		});
	});

	it("before_agent_start sees an idle-time model switch and its abort is honoured", async () => {
		await withRpc("idle-switch-then-abort", async (rpc, observed) => {
			rpc.send({ id: "m1", type: "set_model", provider: STUB_PROVIDER, modelId: STUB_MODEL_2 });
			const switched = await rpc.waitFor((record) => record.type === "response" && record.id === "m1");
			assert.equal(switched.success, true);
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(observed.observations(), [
				{ ran: "model_select", idle: true, ctxModel: STUB_MODEL_2, source: "set" },
				{ ran: "before_agent_start", ctxModel: STUB_MODEL_2, messageType: "user", idle: false },
			]);
			assert.ok(!mentionsReply(rpc.records), "the aborted run sent no request that produced the reply");
			assert.deepEqual(observed.requests(), [], "the abort came before the first request");
			assert.deepEqual(await assistantOutcomes(rpc), [{ stopReason: "error", errorMessage: "This operation was aborted" }]);
		});
	});

	it("a stub provider needs no credentials", async () => {
		const observed = probe("auth-status");
		const result = await runPrint("hello", observed.options);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
		assert.deepEqual(observed.requests(), [STUB_MODEL]);
		assert.ok(observed.observations()[0]?.stubAuth, "the registry reports an auth status for the stub provider");
	});

	it("extension commands such as /guard are dispatched in print mode", async () => {
		const observed = probe("command");
		const result = await runPrint("/guard status now", observed.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(observed.observations(), [{ ran: "command", args: "status now" }]);
		assert.equal(result.stdout, "", "no turn was sent to the model");
	});
});
