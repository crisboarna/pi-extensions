// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARD_EXTENSION, RpcSession, runPrint } from "../support/pi-process.ts";
import { STUB_REPLY } from "../support/stub-provider.ts";

describe("smoke harness", () => {
	it("answers a print-mode prompt offline through the stub provider", async () => {
		const result = await runPrint("hello", { extensions: [] });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
	});

	it("loads the guard extension in real pi without changing the turn", async () => {
		const result = await runPrint("hello", { extensions: [GUARD_EXTENSION] });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
		assert.equal(result.stderr, "");
	});

	it("answers a prompt over RPC with the guard loaded", async () => {
		const rpc = new RpcSession({ extensions: [GUARD_EXTENSION] });
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
