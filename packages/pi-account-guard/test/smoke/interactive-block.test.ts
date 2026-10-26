// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GUARD_EXTENSION, RpcSession, type RpcRecord } from "../support/pi-process.ts";
import { SECOND_PROVIDER } from "../support/second-provider.ts";
import { STUB_MODEL, STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";

const SECOND_EXTENSION = join(import.meta.dirname, "..", "support", "second-provider.ts");

/** Both stub providers are tagged by their `fallback` auth source; the first is work, the second personal. The place falls to the personal default zone. */
const CONFIG = {
	accounts: [
		{ provider: STUB_PROVIDER, source: "fallback", zones: ["work"] },
		{ provider: SECOND_PROVIDER, source: "fallback", zones: ["personal"] },
	],
};

const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;

async function withBlockedPrompt(body: (rpc: RpcSession, requests: () => string[], select: RpcRecord) => Promise<void>): Promise<void> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-interactive-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	writeFileSync(join(agentDir, "account-guard.json"), JSON.stringify(CONFIG));
	const requestLog = join(root, "requests.txt");
	const rpc = new RpcSession({ extensions: [SECOND_EXTENSION, GUARD_EXTENSION], env: { PI_CODING_AGENT_DIR: agentDir, STUB_REQUEST_LOG: requestLog }, cwd: place });
	const requests = () => (existsSync(requestLog) ? readFileSync(requestLog, "utf8").split("\n").filter(Boolean) : []);
	try {
		rpc.send({ id: "p1", type: "prompt", message: "hello" });
		await body(rpc, requests, await rpc.waitFor(isUiRequest("select")));
	} finally {
		await rpc.close();
	}
}

const answer = (rpc: RpcSession, request: RpcRecord, value: string) => rpc.send({ type: "extension_ui_response", id: request.id, value });
const optionStarting = (select: RpcRecord, prefix: string) => (select.options as string[]).find((option) => option.startsWith(prefix));

describe("interactive block over RPC (DESIGN.md section 9.1)", () => {
	it("serves the select through the UI request protocol with the rows in order", async () => {
		await withBlockedPrompt(async (_rpc, requests, select) => {
			assert.match(String(select.title), /^BLOCKED {2}stub \(fallback\) is zone work\nPlace /);
			assert.deepEqual(select.options, [
				`Switch to ${SECOND_PROVIDER} (fallback) -> ${STUB_MODEL}  [personal]`,
				"Allow once: this turn to stub (fallback)",
				"Allow for session: stub (fallback)",
				"Cancel",
			]);
			assert.deepEqual(requests(), [], "nothing is sent while the select is open");
		});
	});

	it("Switch sets the model and sends the same prompt", async () => {
		await withBlockedPrompt(async (rpc, requests, select) => {
			answer(rpc, select, optionStarting(select, "Switch to")!);
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.ok(JSON.stringify(rpc.records).includes(STUB_REPLY));
			assert.deepEqual(requests(), [STUB_MODEL]);
			const notice = await rpc.waitFor(isUiRequest("notify"));
			assert.equal(notice.message, `Switched to ${SECOND_PROVIDER} (fallback), sending.`);
		});
	});

	it("no answer counts as Cancel: the prompt returns to the editor and nothing is sent", async () => {
		await withBlockedPrompt(async (rpc, requests, select) => {
			rpc.send({ type: "extension_ui_response", id: select.id, cancelled: true });
			const refill = await rpc.waitFor(isUiRequest("set_editor_text"));
			assert.equal(refill.text, "hello");
			const response = await rpc.waitFor((record) => record.type === "response" && record.id === "p1");
			assert.deepEqual(response.data, { disposition: "handled" });
			assert.deepEqual(requests(), []);
		});
	});

	it("Allow once asks a confirm, then sends the turn", async () => {
		await withBlockedPrompt(async (rpc, requests, select) => {
			answer(rpc, select, optionStarting(select, "Allow once")!);
			const confirm = await rpc.waitFor(isUiRequest("confirm"));
			assert.match(String(confirm.message), /^Send ONE turn to stub \(fallback\), zone work, from a personal place/);
			rpc.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(requests(), [STUB_MODEL]);
		});
	});

	it("Allow for session sends the turn and shows the Override in the footer", async () => {
		await withBlockedPrompt(async (rpc, requests, select) => {
			answer(rpc, select, optionStarting(select, "Allow for session")!);
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(requests(), [STUB_MODEL]);
			const status = await rpc.waitFor((record) => isUiRequest("setStatus")(record) && String(record.statusText).startsWith("guard OVERRIDE"));
			assert.equal(status.statusKey, "guard");
			assert.match(String(status.statusText), /^guard OVERRIDE stub in personal$/);
		});
	});
});
