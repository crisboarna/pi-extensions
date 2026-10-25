import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";
import type { Answers } from "../../src/rules/types.ts";
import { type EngineDeps, SwitchboardEngine } from "../../src/router/engine.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { type LaunchContext, routeLaunch } from "../../src/subagents/launch.ts";
import { extractTasks, resultLinks } from "../../src/subagents/tasks.ts";
import { seededRng } from "../../src/util/runtime.ts";

const RAW: RawConfig = {
	classifiers: [{ model: "local/judge", threshold: 0.8 }],
	profiles: {
		main: {
			tiers: {
				light: { rank: 1, members: ["acme/small:low"] },
				standard: { rank: 2, members: ["acme/mid"] },
				deep: { rank: 3, members: ["acme/big:high"] },
			},
		},
	},
	profileSelection: { default: "main" },
	subagents: { exclude: ["secret"], agents: { scout: { maxTier: "light" }, planner: { minTier: "deep" } } },
};

const work = (choice: string): Answers => ({ work: { type: "choice", choice, probabilities: {}, confidence: 0.95 }, depth: { type: "score", score: 1, confidence: 0.4 }, risky: { type: "bool", probability: 0.1 } });

function setup(classifyWork: (task: string) => string = () => "plan") {
	const deps: EngineDeps = {
		config: normalizeConfig(RAW),
		missingConfig: false,
		catalog: { find: () => ({ contextWindow: 100_000 }), hasAuth: () => true, isProvider: () => true, subscription: () => true },
		store: new MemoryHealthStore(),
		classify: async (_model, request) => ({ stopReason: "stop", answers: work(classifyWork(String(request.state.request))) }),
		clock: { now: () => Date.UTC(2026, 9, 25) },
		rng: seededRng(5),
		cwd: "/w",
		home: "/h",
		planPhase: async () => "unknown",
		globalProfile: () => undefined,
		subscriptions: () => [],
	};
	const engine = new SwitchboardEngine(deps);
	const ctx = (extra: Partial<LaunchContext> = {}): LaunchContext => ({
		engine,
		toolCallId: "call-1",
		parentVirtualId: "auto",
		parentThinking: "medium",
		planPhase: "executing",
		mode: "child",
		pinLookup: async () => ({}),
		isSwitchboard: (model) => model.startsWith("switchboard/"),
		...extra,
	});
	return { engine, ctx };
}

describe("extractTasks", () => {
	it("reads single, parallel, tasks and chain shapes and writes models back in place", () => {
		const single = { agent: "worker", task: "fix it" };
		const [one] = extractTasks(single);
		one?.setModel("p/m");
		assert.equal((single as Record<string, unknown>).model, "p/m");

		const parallel = { workflow: "parallel", args: { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y", model: "p/fixed" }] } };
		const tasks = extractTasks(parallel);
		assert.deepEqual(tasks.map((t) => [t.agent, t.model, t.shape]), [["a", undefined, "parallel"], ["b", "p/fixed", "parallel"]]);
		tasks[0]?.setModel("p/routed");
		assert.equal(parallel.args.tasks[0]?.model, "p/routed");

		const chain = { task: "original", chain: [{ agent: "scout" }, { parallel: [{ agent: "r1", task: "review {previous}" }, { agent: "r2", task: "t" }] }] };
		assert.deepEqual(extractTasks(chain).map((t) => [t.index, t.agent, t.task]), [[0, "scout", "original"], [1, "r1", "review {previous}"], [2, "r2", "t"]]);

		assert.equal(extractTasks({ tasks: [{ agent: "a", task: "1" }] })[0]?.shape, "tasks");
	});

	it("ignores management actions and workflow scripts", () => {
		assert.deepEqual(extractTasks({ action: "status", agent: "x" }), []);
		assert.deepEqual(extractTasks({ workflow: true }), []);
		assert.deepEqual(extractTasks({ workflow: "scripts/flow.js" }), []);
	});

	it("reads child run links from a tool result", () => {
		assert.deepEqual(resultLinks({ runId: "r", results: [{ index: 1, sessionFile: "/s.jsonl", model: "p/m" }, {}] }), [
			{ index: 1, runId: "r", sessionFile: "/s.jsonl", model: "p/m" },
			{ index: 1, runId: "r" },
		]);
	});
});

describe("routeLaunch", () => {
	it("writes tier-pinned virtual models with the parent's thinking level", async () => {
		const { ctx } = setup();
		const input = { workflow: "parallel", args: { tasks: [{ agent: "worker", task: "design the system" }] } };
		const result = await routeLaunch(ctx(), extractTasks(input));
		assert.equal(result.routed, 1);
		assert.equal(input.args.tasks[0] && (input.args.tasks[0] as Record<string, unknown>).model, "switchboard/main.deep:medium");
		assert.equal(result.decisions[0]?.reason, "launch");
		assert.equal(result.decisions[0]?.subagent?.launchTier, "deep");
	});

	it("applies agent limits: maximum for scouts, minimum for planners", async () => {
		const { ctx } = setup((task) => (task.includes("rename") ? "mechanical" : "plan"));
		const input = { tasks: [{ agent: "scout", task: "design a thing" }, { agent: "planner", task: "rename a file" }] };
		await routeLaunch(ctx(), extractTasks(input));
		assert.deepEqual(input.tasks.map((t) => (t as Record<string, unknown>).model), ["switchboard/main.light:medium", "switchboard/main.deep:medium"]);
	});

	it("never overrides an explicit model, an agent pin, an excluded agent or an unknown pin state", async () => {
		const { ctx } = setup();
		const input = {
			tasks: [
				{ agent: "a", task: "x", model: "other/explicit" },
				{ agent: "pinned", task: "x" },
				{ agent: "secret", task: "x" },
				{ agent: "mystery", task: "x" },
				{ agent: "inherits-switchboard", task: "x" },
			],
		};
		const pinLookup: LaunchContext["pinLookup"] = async (agent) =>
			agent === "pinned" ? { model: "vendor/frontmatter" } : agent === "mystery" ? "unknown" : agent === "inherits-switchboard" ? { model: "switchboard/auto" } : {};
		const result = await routeLaunch(ctx({ pinLookup }), extractTasks(input));
		const models = input.tasks.map((t) => (t as Record<string, unknown>).model);
		assert.deepEqual(models, ["other/explicit", undefined, undefined, undefined, "switchboard/main.deep:medium"]);
		assert.deepEqual(result.decisions.map((d) => d.subagent?.mode), ["skipped", "skipped", "skipped", "skipped", "child"]);
		assert.match(result.decisions[1]?.subagent?.skipped ?? "", /pin vendor\/frontmatter/u);
	});

	it("writes physical members in launch mode", async () => {
		const { ctx } = setup(() => "mechanical");
		const input = { agent: "worker", task: "rename foo" };
		await routeLaunch(ctx({ mode: "launch" }), extractTasks(input));
		assert.equal((input as Record<string, unknown>).model, "acme/mid:medium", "depth 1 is not shallow, so the middle tier");
	});

	it("honours /tier pin --subagents without classifying", async () => {
		let calls = 0;
		const { engine, ctx } = setup();
		engine.deps.classify = async () => (calls++, { stopReason: "stop", answers: work("plan") });
		engine.controls.pin = { target: "@bottom", subagents: true };
		const input = { agent: "worker", task: "design" };
		const result = await routeLaunch(ctx(), extractTasks(input));
		assert.equal((input as Record<string, unknown>).model, "switchboard/main.light:medium");
		assert.equal(result.decisions[0]?.kind, "pinned");
		assert.equal(calls, 0);
	});
});
