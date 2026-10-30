// Runs real pi with a probe extension and a scripted stub model: what tool results and nested
// calls carry for the Recent refs sources (DESIGN.md section 11).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROBE_EXTENSION, runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";

const CODEMODE = ["--tools", "+codemode"];
const extensions = ["builtin:codemode", PROBE_EXTENSION];

function toolCall(name: string, args: Record<string, unknown>): Record<string, string> {
	return { STUB_TOOL_CALL: JSON.stringify({ name, arguments: args }) };
}

describe("tool results (DESIGN.md section 11)", () => {
	it("carry the path exactly as the model sent it, not resolved", async () => {
		const run = probeRun("tool-results", toolCall("read", { path: "@note.txt" }));
		writeFileSync(join(run.dir, "note.txt"), "hello note\n");
		const result = await runPrint("go", run.options);
		assert.equal(result.code, 0, result.stderr);
		const [read] = run.observations().filter((entry) => entry.ran === "tool_result");
		assert.deepEqual(read, { ran: "tool_result", toolName: "read", toolCallId: "stub-call-1", input: { path: "@note.txt" }, isError: false });
	});

	it("record the calls a codemode script made on the codemode result, with their paths as sent and a status each", async () => {
		const script = [
			'await tools.read({ path: "@note.txt" });',
			'await tools.write({ path: "out/made.txt", content: "x" });',
			'try { await tools.read({ path: "missing.txt" }); } catch (error) {}',
			'return "done";',
		].join("\n");
		const run = probeRun("tool-results", toolCall("codemode", { code: script }), { args: CODEMODE, extensions });
		writeFileSync(join(run.dir, "note.txt"), "hello note\n");
		const result = await runPrint("go", run.options);
		assert.equal(result.code, 0, result.stderr);
		const message = run.observations().find((entry) => entry.ran === "tool_message");
		assert.equal(message?.toolName, "codemode");
		const nested = message?.nestedCalls as { calls: Array<{ id: string; name: string; status: string; arguments?: { path?: string } }>; complete: boolean };
		assert.equal(nested.complete, true);
		assert.deepEqual(
			nested.calls.map((call) => [call.id, call.name, call.arguments?.path, call.status]),
			[
				["stub-call-1/1", "read", "@note.txt", "ok"],
				["stub-call-1/2", "write", "out/made.txt", "ok"],
				["stub-call-1/3", "read", "missing.txt", "error"],
			],
		);
	});

	it("raise a tool_result event for each nested call, tied to the codemode call by parentToolCallId", async () => {
		const run = probeRun("tool-results", toolCall("codemode", { code: 'await tools.read({ path: "note.txt" }); return "done";' }), {
			args: CODEMODE,
			extensions,
		});
		writeFileSync(join(run.dir, "note.txt"), "hello note\n");
		await runPrint("go", run.options);
		const events = run.observations().filter((entry) => entry.ran === "tool_result");
		assert.deepEqual(
			events.map((entry) => [entry.toolName, entry.toolCallId, entry.parentToolCallId]),
			[
				["read", "stub-call-1/1", "stub-call-1"],
				["codemode", "stub-call-1", undefined],
			],
		);
	});
});
