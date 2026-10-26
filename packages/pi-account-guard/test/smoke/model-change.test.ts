// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GUARD_EXTENSION, RpcSession, runPrint, type PiOptions, type PrintResult, type RpcRecord } from "../support/pi-process.ts";
import { SECOND_PROVIDER } from "../support/second-provider.ts";
import { STUB_MODEL, STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";

const SECOND_EXTENSION = join(import.meta.dirname, "..", "support", "second-provider.ts");
const PROBE_EXTENSION = join(import.meta.dirname, "..", "support", "probe-extension.ts");

/** pi starts on the stub provider, tagged personal like the place; the probe then moves it to the second provider, tagged work. */
const CONFIG = {
	accounts: [
		{ provider: STUB_PROVIDER, source: "fallback", zones: ["personal"] },
		{ provider: SECOND_PROVIDER, source: "fallback", zones: ["work"] },
	],
};

const ABORT_FAILOVER_NOTICE = /^guard: failover blocked, model changed to stubtwo \(fallback\) \[work\] during a turn in a personal place \(.+\)\. Turn aborted\.$/;

interface Run {
	options: PiOptions;
	place: string;
	/** Model ids of the requests that reached a stub provider, in order. */
	requests(): string[];
	/** Observations the probe extension wrote, in order. */
	observations(): Array<Record<string, unknown>>;
}

function run(scenario: string, extensions: string[]): Run {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-model-change-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	writeFileSync(join(agentDir, "account-guard.json"), JSON.stringify(CONFIG));
	const requestLog = join(root, "requests.txt");
	const probeLog = join(root, "probe.jsonl");
	const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
	return {
		options: { extensions, cwd: place, env: { PI_CODING_AGENT_DIR: agentDir, STUB_REQUEST_LOG: requestLog, PROBE_SCENARIO: scenario, PROBE_LOG: probeLog } },
		place,
		requests: () => lines(requestLog),
		observations: () => lines(probeLog).map((line) => JSON.parse(line)),
	};
}

/** The probe loads before the guard, so its model change at turn start reaches the guard's `model_select`. */
const midTurn = (scenario: string) => run(scenario, [SECOND_EXTENSION, PROBE_EXTENSION, GUARD_EXTENSION]);
/** The probe loads after the guard, so the guard's `input` has already allowed the turn when it changes the model. */
const afterInput = () => run("switch-account-after-input", [SECOND_EXTENSION, GUARD_EXTENSION, PROBE_EXTENSION]);

async function withRpc(r: Run, body: (rpc: RpcSession) => Promise<void>): Promise<void> {
	const rpc = new RpcSession(r.options);
	try {
		await body(rpc);
	} finally {
		await rpc.close();
	}
}

const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;
const isNotice = (pattern: RegExp) => (record: RpcRecord) => isUiRequest("notify")(record) && pattern.test(String(record.message));
const mentionsReply = (records: RpcRecord[]) => records.some((record) => JSON.stringify(record).includes(STUB_REPLY));

describe("model change mid-turn over RPC (DESIGN.md section 9.2)", () => {
	it("aborts the turn, says a failover was blocked, then opens the select without Allow once and with the previous account first", async () => {
		const r = midTurn("switch-account-at-turn-start");
		await withRpc(r, async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const notice = await rpc.waitFor(isNotice(/failover blocked/));
			assert.match(String(notice.message), ABORT_FAILOVER_NOTICE);
			assert.equal(notice.notifyType, "error");
			const select = await rpc.waitFor(isUiRequest("select"));
			assert.match(String(select.title), /^BLOCKED {2}stubtwo \(fallback\) is zone work\nPlace /);
			assert.deepEqual(select.options, [`Switch to ${STUB_PROVIDER} (fallback) -> ${STUB_MODEL}  [personal]`, "Allow for session: stubtwo (fallback)", "Cancel"]);
			assert.deepEqual(r.requests(), [], "no request reached a provider");
		});
	});

	it("Cancel leaves the model as it is and does not resume the turn", async () => {
		const r = midTurn("switch-account-at-turn-start");
		await withRpc(r, async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const select = await rpc.waitFor(isUiRequest("select"));
			rpc.send({ type: "extension_ui_response", id: select.id, cancelled: true });
			await rpc.waitFor((record) => record.type === "agent_settled" && record.aborted === true);
			rpc.send({ id: "s1", type: "get_state" });
			const state = await rpc.waitFor((record) => record.type === "response" && record.id === "s1");
			assert.equal((state.data as { model: { provider: string } }).model.provider, SECOND_PROVIDER);
			assert.ok(!mentionsReply(rpc.records));
			assert.deepEqual(r.requests(), []);
		});
	});

	it("Switch moves back to the previous account and does not send the aborted prompt again", async () => {
		const r = midTurn("switch-account-at-turn-start");
		await withRpc(r, async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const select = await rpc.waitFor(isUiRequest("select"));
			rpc.send({ type: "extension_ui_response", id: select.id, value: (select.options as string[])[0] });
			const notice = await rpc.waitFor(isNotice(/^Switched to /));
			assert.equal(notice.message, `Switched to ${STUB_PROVIDER} (fallback). The aborted turn is not resumed.`);
			rpc.send({ id: "s1", type: "get_state" });
			const state = await rpc.waitFor((record) => record.type === "response" && record.id === "s1");
			assert.equal((state.data as { model: { provider: string } }).model.provider, STUB_PROVIDER);
			assert.ok(!mentionsReply(rpc.records));
			assert.deepEqual(r.requests(), []);
		});
	});

	it("Allow for session shows the Override in the footer", async () => {
		const r = midTurn("switch-account-at-turn-start");
		await withRpc(r, async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const select = await rpc.waitFor(isUiRequest("select"));
			rpc.send({ type: "extension_ui_response", id: select.id, value: "Allow for session: stubtwo (fallback)" });
			const status = await rpc.waitFor((record) => isUiRequest("setStatus")(record) && String(record.statusText).startsWith("guard OVERRIDE"));
			assert.equal(status.statusText, "guard OVERRIDE stubtwo in personal");
		});
	});
});

describe("idle-time switch (DESIGN.md section 8)", () => {
	it("is caught in before_agent_start: the run is aborted before the first request", async () => {
		const r = afterInput();
		await withRpc(r, async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const notice = await rpc.waitFor(isNotice(/blocked before sending/));
			assert.match(String(notice.message), /^guard: blocked before sending, the model is stubtwo \(fallback\) \[work\] in a personal place \(.+\)\. Run aborted, no request was sent\.$/);
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.ok(!mentionsReply(rpc.records));
			assert.deepEqual(r.requests(), []);
		});
	});
});

describe("headless (DESIGN.md section 9.3)", () => {
	const printResult = (r: Run): Promise<PrintResult> => runPrint("hello", r.options);

	it("a mid-turn change writes the failover notice to stderr, keeps stdout clean and exits 77", async () => {
		const r = midTurn("switch-account-at-turn-start");
		const result = await printResult(r);
		assert.equal(result.code, 77, result.stderr);
		assert.equal(result.stdout, "");
		// pi prints the aborted message's error text after the guard's notice.
		const [notice, piError] = result.stderr.trim().split("\n");
		assert.match(String(notice), ABORT_FAILOVER_NOTICE);
		assert.equal(piError, "This operation was aborted");
		assert.deepEqual(r.requests(), []);
	});

	it("an idle-time switch writes the Block message to stderr and exits 77", async () => {
		const r = afterInput();
		const result = await printResult(r);
		assert.equal(result.code, 77, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^BLOCKED stubtwo \(fallback\) is zone work; this place\n/);
		assert.deepEqual(r.requests(), []);
	});
});

describe("a rotation inside agent_end, like pi-multi-pass (DESIGN.md section 13.1)", () => {
	it("aborts in the awaited chain, Blocks the retry once, and stops without a loop or a request to the rotated account", async () => {
		const r = midTurn("rotate-in-agent-end");
		await withRpc(r, async (rpc) => {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			await rpc.waitFor(isNotice(/failover blocked/));
			// The retry goes through `input`, which Blocks it with the full select.
			const select = await rpc.waitFor(isUiRequest("select"));
			assert.ok((select.options as string[]).some((option) => option.startsWith("Allow once")));
			rpc.send({ type: "extension_ui_response", id: select.id, cancelled: true });
			await rpc.waitFor((record) => record.type === "agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 1000));
			assert.equal(rpc.records.filter(isUiRequest("select")).length, 1, "the idle select does not repeat the Block of the retry");
			assert.deepEqual(r.observations(), [{ ran: "agent_end", idle: false }, { ran: "model_select", idle: false }, { switched: true }]);
			assert.deepEqual(r.requests(), [STUB_MODEL], "only the first turn reached a provider");
		});
	});
});
