import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTasks, isAsyncLaunch, resultLinks } from "../../src/subagents/tasks.ts";

const shape = (input: unknown) => extractTasks(input).map((t) => [t.shape, t.index, t.agent, t.task, t.model ?? null]);

describe("extractTasks", () => {
	it("returns nothing for non-objects, management actions and workflow scripts", () => {
		assert.deepEqual(extractTasks("x"), []);
		assert.deepEqual(extractTasks({ action: "status" }), []);
		assert.deepEqual(extractTasks({ options: { action: "kill" }, agent: "scout" }), []);
		assert.deepEqual(extractTasks({ workflow: "custom-script", agent: "scout" }), []);
		assert.deepEqual(extractTasks({ task: "no agent" }), []);
		assert.deepEqual(extractTasks({ options: "not an object", agent: " " }), []);
	});

	it("reads parallel workflows from the call or its options, skipping items without an agent", () => {
		assert.deepEqual(
			shape({
				workflow: "parallel",
				model: "acme/mid",
				args: { tasks: [{ agent: "scout", task: "a" }, "junk", { task: "no agent" }, { agent: "worker", model: "zen/big" }] },
			}),
			[
				["parallel", 0, "scout", "a", "acme/mid"],
				["parallel", 3, "worker", "", "zen/big"],
			],
		);
		assert.deepEqual(shape({ options: { workflow: "parallel", args: { tasks: [{ agent: "scout" }] } } }), [["parallel", 0, "scout", "", null]]);
		assert.deepEqual(shape({ workflow: "parallel", args: "x" }), []);
		assert.deepEqual(shape({ workflow: "parallel", args: { tasks: "x" } }), []);
	});

	it("reads structured tasks from the call or its options", () => {
		assert.deepEqual(shape({ tasks: [{ agent: "scout", task: "a" }, 3] }), [["tasks", 0, "scout", "a", null]]);
		assert.deepEqual(shape({ options: { tasks: [{ agent: "worker", task: "b" }] } }), [["tasks", 0, "worker", "b", null]]);
	});

	it("reads chains with parallel steps, falling back to the call's task", () => {
		const input = {
			task: "the original request",
			options: { chain: [{ agent: "scout" }, "junk", { parallel: [{ agent: "a", task: "x" }, 5, { task: "no agent" }] }, { task: "no agent" }] },
		};
		assert.deepEqual(shape(input), [
			["chain", 0, "scout", "the original request", null],
			["chain", 1, "a", "x", null],
		]);
		assert.deepEqual(shape({ chain: [{ agent: "solo" }] }), [["chain", 0, "solo", "", null]]);
	});

	it("writes a model back into the exact place the call holds it", () => {
		const single = { agent: "scout", task: "go" };
		const [task] = extractTasks(single);
		task?.setModel("switchboard/work.light");
		assert.equal((single as { model?: string }).model, "switchboard/work.light");
		const parallel = { workflow: "parallel", args: { tasks: [{ agent: "scout" }] } };
		extractTasks(parallel)[0]?.setModel("switchboard/work.deep");
		assert.equal((parallel.args.tasks[0] as { model?: string }).model, "switchboard/work.deep");
	});
});

describe("results", () => {
	it("recognises background launches", () => {
		assert.equal(isAsyncLaunch({ asyncId: "a1" }), true);
		assert.equal(isAsyncLaunch({ asyncDir: "/tmp/run" }), true);
		assert.equal(isAsyncLaunch({ asyncId: " " }), false);
		assert.equal(isAsyncLaunch(null), false);
	});

	it("links results by index, inheriting the top-level run id", () => {
		assert.deepEqual(resultLinks("x"), []);
		assert.deepEqual(resultLinks({ results: "x" }), []);
		assert.deepEqual(
			resultLinks({
				runId: "run-top",
				results: [{ index: 2, runId: "run-2", sessionFile: "/s.jsonl", model: "acme/mid" }, "junk", { sessionFile: " " }],
			}),
			[
				{ index: 2, runId: "run-2", sessionFile: "/s.jsonl", model: "acme/mid" },
				{ index: 2, runId: "run-top" },
			],
		);
	});
});
