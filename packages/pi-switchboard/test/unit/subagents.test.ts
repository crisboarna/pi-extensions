import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";
import { type EngineDeps, SwitchboardEngine } from "../../src/router/engine.ts";
import type { Answers } from "../../src/rules/types.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { attachBinding, BINDING_NAMESPACE, matchLaunch, readBinding, taskDigest } from "../../src/subagents/binding.ts";
import { type LaunchContext, routeLaunch } from "../../src/subagents/launch.ts";
import { runnerOf } from "../../src/subagents/pi-subagents.ts";
import { extractTasks, isAsyncLaunch, resultLinks } from "../../src/subagents/tasks.ts";
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

const work = (choice: string): Answers => ({
	work: { type: "choice", choice, probabilities: {}, confidence: 0.95 },
	depth: { type: "score", score: 1, confidence: 0.4 },
	risky: { type: "bool", probability: 0.1 },
});

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
		parentTask: 3,
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

		const parallel = {
			workflow: "parallel",
			args: {
				tasks: [
					{ agent: "a", task: "x" },
					{ agent: "b", task: "y", model: "p/fixed" },
				],
			},
		};
		const tasks = extractTasks(parallel);
		assert.deepEqual(
			tasks.map((t) => [t.agent, t.model, t.shape]),
			[
				["a", undefined, "parallel"],
				["b", "p/fixed", "parallel"],
			],
		);
		tasks[0]?.setModel("p/routed");
		assert.equal(parallel.args.tasks[0]?.model, "p/routed");

		const chain = {
			task: "original",
			chain: [
				{ agent: "scout" },
				{
					parallel: [
						{ agent: "r1", task: "review {previous}" },
						{ agent: "r2", task: "t" },
					],
				},
			],
		};
		assert.deepEqual(
			extractTasks(chain).map((t) => [t.index, t.agent, t.task]),
			[
				[0, "scout", "original"],
				[1, "r1", "review {previous}"],
				[2, "r2", "t"],
			],
		);

		assert.equal(extractTasks({ tasks: [{ agent: "a", task: "1" }] })[0]?.shape, "tasks");
	});

	it("ignores management actions and workflow scripts", () => {
		assert.deepEqual(extractTasks({ action: "status", agent: "x" }), []);
		assert.deepEqual(extractTasks({ workflow: true }), []);
		assert.deepEqual(extractTasks({ workflow: "scripts/flow.js" }), []);
	});

	it("tells background launches from finished ones", () => {
		assert.equal(isAsyncLaunch({ asyncId: "a1", results: [] }), true);
		assert.equal(isAsyncLaunch({ runId: "r", results: [{}] }), false);
		assert.equal(isAsyncLaunch(undefined), false);
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
		assert.equal(result.decisions[0]?.task, 3, "a launch sits under the parent task that made the call");
		assert.ok(result.decisions.every((d) => d.task === 3));
		assert.equal(result.decisions[0]?.subagent?.launchTier, "deep");
	});

	it("applies agent limits: maximum for scouts, minimum for planners", async () => {
		const { ctx } = setup((task) => (task.includes("rename") ? "mechanical" : "plan"));
		const input = {
			tasks: [
				{ agent: "scout", task: "design a thing" },
				{ agent: "planner", task: "rename a file" },
			],
		};
		await routeLaunch(ctx(), extractTasks(input));
		assert.deepEqual(
			input.tasks.map((t) => (t as Record<string, unknown>).model),
			["switchboard/main.light:medium", "switchboard/main.deep:medium"],
		);
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
			agent === "pinned"
				? { model: "vendor/frontmatter" }
				: agent === "mystery"
					? "unknown"
					: agent === "inherits-switchboard"
						? { model: "switchboard/auto" }
						: {};
		const result = await routeLaunch(ctx({ pinLookup }), extractTasks(input));
		const models = input.tasks.map((t) => (t as Record<string, unknown>).model);
		assert.deepEqual(models, ["other/explicit", undefined, undefined, undefined, "switchboard/main.deep:medium"]);
		assert.deepEqual(
			result.decisions.map((d) => d.subagent?.mode),
			["skipped", "skipped", "skipped", "skipped", "child"],
		);
		assert.match(result.decisions[1]?.subagent?.skipped ?? "", /pin vendor\/frontmatter/u);
	});

	it("writes physical members in launch mode", async () => {
		const { ctx } = setup(() => "mechanical");
		const input = { agent: "worker", task: "rename foo" };
		await routeLaunch(ctx({ mode: "launch" }), extractTasks(input));
		assert.equal((input as Record<string, unknown>).model, "acme/mid:medium", "depth 1 is not shallow, so the middle tier");
	});

	it("runs the tier's strategy in launch mode, spreads parallel tasks and holds leases", async () => {
		const rr: RawConfig = {
			...RAW,
			profiles: {
				main: {
					tiers: {
						light: { rank: 1, members: ["acme/small"] },
						standard: { rank: 2, members: ["acme/mid", "zen/mid"], strategy: { name: "round-robin", granularity: "request" } },
						deep: { rank: 3, members: ["acme/big"] },
					},
				},
			},
		};
		const { engine, ctx } = setup(() => "implement");
		engine.deps.config = normalizeConfig(rr);
		const input = {
			tasks: [
				{ agent: "a", task: "x" },
				{ agent: "b", task: "y" },
				{ agent: "c", task: "z" },
			],
		};
		const result = await routeLaunch(ctx({ mode: "launch" }), extractTasks(input));
		assert.deepEqual(
			input.tasks.map((t) => (t as Record<string, unknown>).model),
			["acme/mid:medium", "zen/mid:medium", "acme/mid:medium"],
		);
		assert.equal(result.leases.length, 3);
		for (const lease of result.leases) engine.releaseLease(lease);
		assert.equal(engine.deps.store.read().members["acme/mid"]?.leases?.length, 0);
	});

	it("skips a launch-mode task when its whole tier and neighbours are cooling down", async () => {
		const { engine, ctx } = setup(() => "implement");
		for (const model of ["acme/small", "acme/mid", "acme/big"]) {
			const [provider = "", id = ""] = model.split("/");
			engine.prepareFailover({ provider, id }, "usage limit reached");
		}
		const input = { agent: "worker", task: "build it" };
		const result = await routeLaunch(ctx({ mode: "launch" }), extractTasks(input));
		assert.equal((input as Record<string, unknown>).model, undefined);
		assert.match(result.decisions[0]?.subagent?.skipped ?? "", /cooling down/u);
	});

	it("honours /tier pin --subagents without classifying", async () => {
		let calls = 0;
		const { engine, ctx } = setup();
		engine.deps.classify = async () => {
			calls++;
			return { stopReason: "stop", answers: work("plan") };
		};
		engine.controls.pin = { target: "@bottom", subagents: true };
		const input = { agent: "worker", task: "design" };
		const result = await routeLaunch(ctx(), extractTasks(input));
		assert.equal((input as Record<string, unknown>).model, "switchboard/main.light:medium");
		assert.equal(result.decisions[0]?.kind, "pinned");
		assert.equal(calls, 0);
	});
});

describe("external runners", () => {
	it("reads the runner type from agent frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-agents-"));
		const external = join(dir, "ext.md");
		const native = join(dir, "native.md");
		writeFileSync(external, "---\nname: ext\nrunner:\n  type: external-cli\n  command: tool\n---\nbody\n");
		writeFileSync(native, "---\nname: native\nmodel: inherit\n---\nbody\n");
		assert.equal(runnerOf(external), "external");
		assert.equal(runnerOf(native), "native");
		assert.equal(runnerOf(undefined), "native");
	});

	it("never routes an external-runner agent and records each task's runner", async () => {
		const { ctx } = setup();
		const input = {
			tasks: [
				{ agent: "codex-exec", task: "x" },
				{ agent: "worker", task: "y" },
			],
		};
		const pinLookup: LaunchContext["pinLookup"] = async (agent) => (agent === "codex-exec" ? { runner: "external" } : { runner: "native" });
		const result = await routeLaunch(ctx({ pinLookup }), extractTasks(input));
		assert.equal((input.tasks[0] as Record<string, unknown>).model, undefined);
		assert.equal(result.decisions[0]?.subagent?.skipped, "the agent uses an external runner");
		assert.deepEqual(
			result.decisions.map((d) => d.subagent?.runner),
			["external", "native"],
		);
	});
});

describe("launch bindings", () => {
	it("adds the pi-switchboard/1 binding next to other extensions' bindings", () => {
		const input: Record<string, unknown> = { agent: "worker", task: "t", options: { extensionBindings: { "other.ext/2": { keep: true } } } };
		assert.ok(attachBinding(input, { parent: "/s/p.jsonl", launches: [{ d: taskDigest("worker", "t"), a: "worker", id: "d_1" }] }));
		const bindings = (input.options as Record<string, Record<string, unknown>>).extensionBindings ?? {};
		assert.deepEqual(Object.keys(bindings).sort(), ["other.ext/2", BINDING_NAMESPACE]);
		assert.match(BINDING_NAMESPACE, /^[a-z0-9][a-z0-9._-]*\/[1-9]\d*$/u, "pi-subagents namespace format");
		assert.ok(JSON.stringify(bindings).length < 16 * 1024);
		assert.equal(attachBinding({}, { parent: "p", launches: [] }), false);
	});

	it("reads the binding in a child and matches its launch", () => {
		const launches = [
			{ d: taskDigest("scout", "scan src"), a: "scout", id: "d_a" },
			{ d: taskDigest("scout", "scan test"), a: "scout", id: "d_b" },
			{ d: taskDigest("reviewer", "review"), a: "reviewer", id: "d_c" },
		];
		const env = { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ [BINDING_NAMESPACE]: { parent: "p", launches }, "x/1": {} }) };
		const binding = readBinding(env);
		assert.ok(binding);
		if (!binding) return;
		assert.equal(matchLaunch(binding, "scout", "scan test"), "d_b", "exact digest");
		assert.equal(matchLaunch(binding, "reviewer", "review, with a prefix the runner added"), "d_c", "the only launch of that agent");
		assert.equal(matchLaunch(binding, "scout", "something else"), undefined, "ambiguous");
		assert.equal(readBinding({}), undefined);
		assert.equal(readBinding({ PI_SUBAGENT_EXTENSION_BINDINGS: "{bad" }), undefined);
	});
});
