// End to end in real pi with no model server: pi-subagents, at the version the
// repository pins, launches children that pi-switchboard routes. The parent's
// stand-in model calls the `subagent` tool as each test scripts; the stand-in
// classifier answers each task by its text, since parallel tasks arrive in any
// order; each child's requests show which model ran it. Children run in the
// foreground (`async: false`), in pi's own process. Background children run as
// detached processes whose results arrive in a later parent turn; they are
// left out to keep the suite quick and its timing fixed. Runs in
// `npm run test:e2e`, and so in CI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Turn } from "./support/pi-rpc.ts";
import type { Request, Step } from "./support/standin-provider.ts";
import { routingConfig, type Standins, startStandins } from "./support/standins.ts";

const USAGE_LIMIT = "You have hit your usage limit. Try again in ~30 min.";

/** The parent's first reply: a `subagent` call running `tasks` in the foreground. */
const launch = (tasks: Array<Record<string, string>>): Step => ({
	toolCall: {
		name: "subagent",
		arguments: tasks.length === 1 ? { ...tasks[0], async: false } : { workflow: "parallel", args: { tasks }, async: false },
	},
});
const delegate = (task: string, extra: Record<string, string> = {}) => ({ agent: "delegate", task, ...extra });

/** Each child's models, in order, by its task. */
function childModels(requests: Request[]): Record<string, string[]> {
	const byTask: Record<string, string[]> = {};
	for (const request of requests) {
		const task = /^Task: (.+)$/mu.exec(request.user)?.[1];
		if (task) byTask[task] = [...(byTask[task] ?? []), request.model];
	}
	return byTask;
}

/** The model pi-switchboard wrote into each launched task, by session name (`delegate: <task>`). */
function launchedModels(turn: Turn): Record<string, string> {
	const ended = turn.records.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent");
	const results = ((ended?.result as { details?: { results?: Array<{ sessionName?: string; model?: string }> } })?.details?.results ?? []).map((result) => [
		String(result.sessionName),
		String(result.model).replace(/:\w+$/u, ""),
	]);
	return Object.fromEntries(results);
}

describe("subagents in real pi: pi-subagents children get their own tier", { timeout: 300_000 }, () => {
	let s: Standins;
	const explain = (text: string) => s.runDir.explain(text);
	const subagentRequests = () => s.classifier.requests.filter((request) => request.state.scope === "subagent").map((request) => request.state.request);

	before(async () => {
		s = await startStandins("subagents", { subagents: true });
		// A user agent whose frontmatter pins a model.
		mkdirSync(join(s.installed.agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(s.installed.agentDir, "agents", "pinned.md"),
			"---\nname: pinned\ndescription: An agent pinned to one model\nmodel: beta/big\n---\n\nDo the task.\n",
		);
	});

	after(async () => {
		await s?.close();
	});

	it("classifies each task of a call once, runs each on the tier its answers give, and doctor says so", async () => {
		const tasks = [delegate("scout the repo layout"), delegate("implement the parser"), delegate("review the parser")];
		const { pi, requests } = await s.open("tiers", routingConfig(s.classifier), { script: { models: { "alpha/mid": [launch(tasks)] } } });
		s.classifier.when(/scout/u, { choices: { work: "mechanical" }, scores: { depth: 0 } });
		s.classifier.when(/review/u, { choices: { work: "review" } });
		const turn = await pi.prompt("split the work", 120_000);
		assert.deepEqual(
			[...subagentRequests()].sort(),
			["implement the parser", "review the parser", "scout the repo layout"],
			explain(JSON.stringify(s.classifier.requests.map((r) => r.state))),
		);
		assert.deepEqual(launchedModels(turn), {
			"delegate: scout the repo layout": "switchboard/work.light",
			"delegate: implement the parser": "switchboard/work.standard",
			"delegate: review the parser": "switchboard/work.deep",
		});
		assert.deepEqual(childModels(requests()), {
			"scout the repo layout": ["alpha/small"],
			"implement the parser": ["alpha/mid"],
			"review the parser": ["alpha/big"],
		});
		assert.match(await pi.command("/tier doctor"), /^✓ subagents are routed inside their children$/mu);
	});

	it("keeps a task's own model and an agent's pinned model, without classifying them", async () => {
		const tasks = [delegate("look up the version", { model: "beta/small" }), { agent: "pinned", task: "check the license" }];
		const { pi, requests } = await s.open("own-models", routingConfig(s.classifier), { script: { models: { "alpha/mid": [launch(tasks)] } } });
		await pi.prompt("split the work", 120_000);
		assert.deepEqual(subagentRequests(), [], explain("a task with its own model was classified"));
		assert.deepEqual(childModels(requests()), { "look up the version": ["beta/small"], "check the license": ["beta/big"] });
	});

	it("caps a task's tier at the agent's maxTier", async () => {
		const config = routingConfig(s.classifier, { subagents: { agents: { delegate: { maxTier: "standard" } } } });
		const { pi, requests } = await s.open("max-tier", config, { script: { models: { "alpha/mid": [launch([delegate("review the parser")])] } } });
		s.classifier.when(/review/u, { choices: { work: "review" } });
		const turn = await pi.prompt("split the work", 120_000);
		assert.deepEqual(launchedModels(turn), { "delegate: review the parser": "switchboard/work.standard" });
		assert.deepEqual(childModels(requests()), { "review the parser": ["alpha/mid"] });
	});

	it("fails over inside the child when its member hits a usage limit", async () => {
		const { pi, requests } = await s.open("child-failover", routingConfig(s.classifier), {
			script: { models: { "alpha/mid": [launch([delegate("scout the repo layout")])], "alpha/small": [{ error: USAGE_LIMIT }] } },
		});
		s.classifier.when(/scout/u, { choices: { work: "mechanical" }, scores: { depth: 0 } });
		await pi.prompt("split the work", 120_000);
		assert.deepEqual(childModels(requests()), { "scout the repo layout": ["alpha/small", "beta/small"] });
	});

	it("escalates a child one tier after its bash fails twice, but not past the agent's maxTier", async () => {
		const failing: Step[] = [
			{ toolCall: { name: "bash", arguments: { command: "exit 3" } } },
			{ toolCall: { name: "bash", arguments: { command: "exit 3" } } },
		];
		const script = { models: { "alpha/mid": [launch([delegate("scout the repo layout")])], "alpha/small": failing } };
		const scout = () => s.classifier.when(/scout/u, { choices: { work: "mechanical" }, scores: { depth: 0 } });
		const free = await s.open("escalates", routingConfig(s.classifier), { script });
		scout();
		await free.pi.prompt("split the work", 120_000);
		assert.deepEqual(childModels(free.requests()), { "scout the repo layout": ["alpha/small", "alpha/small", "alpha/mid"] });

		const capped = await s.open("escalation-capped", routingConfig(s.classifier, { subagents: { agents: { delegate: { maxTier: "light" } } } }), {
			script,
		});
		scout();
		await capped.pi.prompt("split the work", 120_000);
		assert.deepEqual(childModels(capped.requests()), { "scout the repo layout": ["alpha/small", "alpha/small", "alpha/small"] });
	});
});
