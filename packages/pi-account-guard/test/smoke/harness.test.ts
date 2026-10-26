// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GUARD_EXTENSION, RpcSession, runPrint } from "../support/pi-process.ts";
import { STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";

/** An agent directory whose config tags the stub account for the default zone, so the guard lets its turns through. */
function taggedAgentEnv(): Record<string, string> {
	const agentDir = join(mkdtempSync(join(tmpdir(), "account-guard-harness-")), "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "account-guard.json"), JSON.stringify({ accounts: [{ provider: STUB_PROVIDER, source: "fallback", zones: ["personal"] }] }));
	return { PI_CODING_AGENT_DIR: agentDir };
}

describe("smoke harness", () => {
	it("answers a print-mode prompt offline through the stub provider", async () => {
		const result = await runPrint("hello", { extensions: [] });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
	});

	it("loads the guard extension in real pi and lets a tagged turn through unchanged", async () => {
		const result = await runPrint("hello", { extensions: [GUARD_EXTENSION], env: taggedAgentEnv() });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
		assert.equal(result.stderr, "");
	});

	it("answers a prompt over RPC with the guard loaded", async () => {
		const rpc = new RpcSession({ extensions: [GUARD_EXTENSION], env: taggedAgentEnv() });
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const settled = await rpc.waitFor((record) => record.type === "agent_settled");
			assert.ok(settled);
			const answered = rpc.records.some((record) => JSON.stringify(record).includes(STUB_REPLY));
			assert.ok(answered, "the stub reply appears in the event stream");
		} finally {
			await rpc.close();
		}
	});
});
