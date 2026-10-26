import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type createFakeHost, type createFakeSession, fakeTheme, routeRequest } from "../support/fake-pi.ts";
import { boot, INDEX } from "../support/harness.ts";

describe("extension loaded through jiti", () => {
	it("registers the virtual models, classifier provider, command and renderer", async () => {
		const { host } = await boot();
		assert.deepEqual([...host.virtualModels.keys()].sort(), ["auto", "work", "work.deep", "work.light", "work.standard"]);
		assert.ok(host.providers.has("local"), "the System One classifier server is registered as a provider");
		assert.ok(host.commands.has("tier"));
		assert.ok(host.renderers.has("pi-switchboard.decision"));
		for (const event of ["session_start", "model_select", "message_end", "tool_call", "tool_result", "after_provider_response", "session_shutdown"]) {
			assert.ok(host.handlerCount(event) > 0, `${event} is handled`);
		}
	});

	it("stays inactive and explains why when there is no config", async () => {
		const { host, session, route } = await boot({ config: { profiles: {}, profileSelection: {} } });
		assert.match(session.statuses.get("tier") ?? "", /switchboard inactive/u);
		await assert.rejects(Promise.resolve(route(routeRequest())), /inactive: no profiles configured/u);
		assert.equal(host.entries.length, 0);
	});
});

describe("routing a session with recorded requests", () => {
	it("classifies a user turn, picks the tier's model, records the decision and sets the footer", async () => {
		const { session, route, decisions, host } = await boot({ scenario: "plan" });
		const out = await route(routeRequest({ text: "design the architecture for the billing service" }));
		assert.deepEqual([out.model.provider, out.model.id, out.thinkingLevel], ["acme", "big", "high"]);
		assert.equal(out.state.tier, "deep");
		const [decision] = decisions();
		assert.equal(decision.kind, "classified");
		assert.equal(decision.evidence.state.planMode, "executing", "the Plannotator phase reached the evidence");
		assert.equal(decision.classifier.model, "local/judge");
		assert.equal(session.classifierCalls[0]?.state.request, "design the architecture for the billing service");
		assert.equal(session.statuses.get("tier"), "work · deep · big · 0.95");
		assert.ok(
			host.entries.some((e) => e.customType === "pi-switchboard.profile"),
			"the profile snapshot is recorded for the inspector",
		);
	});

	it("keeps the model on continuation and fails over on a rate limit", async () => {
		const { route, decisions } = await boot({ scenario: "implement" });
		const first = await route(routeRequest());
		assert.equal(first.model.id, "mid");
		const previous = { model: { provider: "acme", id: "mid" }, thinkingLevel: "medium" };
		const same = await route(routeRequest({ reason: "continuation", previous, state: first.state }));
		assert.deepEqual([same.model.provider, same.model.id], ["acme", "mid"]);
		assert.equal(decisions().length, 1, "plain continuations write no decision");
		const retry = await route(
			routeRequest({ reason: "retry", state: first.state, failed: { ...previous, message: { errorMessage: "429 Too Many Requests. Retry-After: 30" } } }),
		);
		assert.deepEqual([retry.model.provider, retry.model.id], ["zen", "mid"]);
		const failover = decisions().at(-1);
		assert.deepEqual([failover.kind, failover.error.class], ["failover", "rate-limit"]);
		assert.equal(failover.switch.cacheMiss, true);
	});

	it("falls back to the fallback tier when the classifier is down, and says why", async () => {
		const { route, decisions } = await boot({ scenario: "fail" });
		const out = await route(routeRequest());
		assert.equal(out.model.id, "mid");
		const [decision] = decisions();
		assert.deepEqual([decision.kind, decision.classifier.failure], ["fallback", "classifier-error"]);
		assert.equal(decision.classifier.attempts[0].error, "connection refused");
	});

	it("rewrites a usage-limit error so pi retries it, and appends successful usage to the ledger", async () => {
		const { host, session, route, agentDir } = await boot();
		const first = await route(routeRequest());
		const limited = await host.fire(
			"message_end",
			{
				message: {
					role: "assistant",
					provider: "acme",
					model: "mid",
					stopReason: "error",
					errorMessage: "You have hit your ChatGPT usage limit. Try again in ~30 min.",
				},
			},
			session.ctx,
		);
		assert.match(limited.message.errorMessage, /^pi-switchboard: .*retrying on another model.*Original error: You have hit your ChatGPT usage limit/u);
		const retry = await route(
			routeRequest({
				reason: "retry",
				state: first.state,
				failed: { model: { provider: "acme", id: "mid" }, message: { errorMessage: limited.message.errorMessage } },
			}),
		);
		assert.deepEqual([retry.model.provider, retry.model.id], ["zen", "mid"], "the whole acme account is benched, so the other provider takes over");
		await host.fire(
			"message_end",
			{
				message: {
					role: "assistant",
					provider: "zen",
					model: "mid",
					stopReason: "stop",
					usage: { input: 500, output: 80, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
				},
			},
			session.ctx,
		);
		const ledger = join(agentDir, "pi-switchboard", "usage.jsonl");
		assert.ok(existsSync(ledger));
		const [entry] = readFileSync(ledger, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.deepEqual([entry.provider, entry.model, entry.input, entry.output, entry.cost], ["zen", "mid", 500, 80, 0.002]);
	});

	it("renders a decision entry for the TUI, collapsed and expanded", async () => {
		const { host, route, decisions } = await boot({ scenario: "plan" });
		await route(routeRequest());
		const render = host.renderers.get("pi-switchboard.decision");
		assert.ok(render);
		const collapsed = render({ data: decisions()[0] }, { expanded: false }, fakeTheme).render(100).join("\n");
		assert.match(collapsed, /⇄ task 1 · work=plan \(0\.95\) · deep → big:high/u);
		assert.ok(!collapsed.includes("classifier:"));
		const expanded = render({ data: decisions()[0] }, { expanded: true }, fakeTheme).render(100).join("\n");
		assert.match(expanded, /classifier: local\/judge/u);
		assert.match(expanded, /gate 0\.95 vs 0\.8/u);
	});
});

describe("/tier commands", () => {
	it("pins a tier without classifying, dry-runs to the baseline, and validates", async () => {
		const { session, route, decisions, tier } = await boot({ scenario: "plan" });
		await tier("pin @bottom");
		const pinned = await route(routeRequest());
		assert.equal(pinned.model.id, "small");
		assert.equal(decisions().at(-1).kind, "pinned");
		assert.equal(session.classifierCalls.length, 0, "a pin skips the classifier");
		assert.match(session.statuses.get("tier") ?? "", /pinned @bottom/u);
		await tier("pin auto");
		await tier("dry-run on");
		const dry = await route(routeRequest({ state: pinned.state }));
		assert.equal(decisions().at(-1).dryRun, true);
		assert.equal(decisions().at(-1).tier.candidate, "deep", "the classifier still ran");
		assert.equal(dry.model.id, "mid", "but the baseline tier (the fallback tier) ran");
		await tier("validate");
		assert.match(session.notices.at(-1)?.message ?? "", /Valid profiles: work/u);
		await tier("log 5");
		assert.match(session.notices.at(-1)?.message ?? "", /⇄ task/u);
	});

	it("reports exhaustion, schedules the opt-in auto-continue once, and cancels it", async () => {
		const solo = {
			profiles: { work: { tiers: { only: { rank: 1, members: ["acme/mid"] } } } },
			exhaustion: { autoContinue: true },
		};
		const { session, route, tier, host } = await boot({ config: solo });
		const first = await route(routeRequest());
		await assert.rejects(
			Promise.resolve(
				route(
					routeRequest({
						reason: "retry",
						state: first.state,
						failed: { model: { provider: "acme", id: "mid" }, message: { errorMessage: "429 Too Many Requests. Retry-After: 30" } },
					}),
				),
			),
			/every model is cooling down/u,
		);
		await assert.rejects(Promise.resolve(route(routeRequest())), /every model is cooling down; earliest reset/u);
		const messages = session.notices.map((n) => n.message);
		assert.ok(
			messages.some((m) => m.includes('will send "continue"')),
			"auto-continue was scheduled",
		);
		await tier("resume cancel");
		assert.match(session.notices.at(-1)?.message ?? "", /cancelled/u);
		assert.equal(host.sentMessages.length, 0, "nothing was sent for the user");
	});
});

describe("subagent launches", () => {
	const call = (host: ReturnType<typeof createFakeHost>, session: ReturnType<typeof createFakeSession>, input: Record<string, unknown>, id = "call-1") =>
		host.fire("tool_call", { toolName: "subagent", toolCallId: id, input }, session.ctx);
	const result = (host: ReturnType<typeof createFakeHost>, session: ReturnType<typeof createFakeSession>, details: unknown, id = "call-1") =>
		host.fire("tool_result", { toolName: "subagent", toolCallId: id, details, content: [] }, session.ctx);

	it("registers pi-switchboard as a required child extension and writes a tier-pinned model plus a binding", async () => {
		const { host, session, decisions } = await boot({ subagents: {} });
		const registered = (globalThis as { __switchboardTest?: { registered?: { sessionId: string; extensions: Array<{ id: string; path: string }> } } })
			.__switchboardTest?.registered;
		assert.deepEqual([registered?.sessionId, registered?.extensions[0]?.id], ["session-1", "pi-switchboard"]);
		assert.equal(registered?.extensions[0]?.path, INDEX);

		const input: Record<string, any> = { agent: "scout", task: "scan the repo" };
		await call(host, session, input);
		assert.equal(input.model, "switchboard/work.standard:medium", "the classifier's tier, within the scout's maximum");
		const launch = decisions().find((d) => d.reason === "launch");
		assert.deepEqual([launch.subagent.mode, launch.subagent.runner, launch.subagent.launchTier], ["child", "native", "standard"]);
		const binding = input.options.extensionBindings["pi-switchboard/1"];
		assert.equal(binding.launches[0].id, launch.id);
		assert.equal(session.statuses.get("tier-sub"), "1 subagents routed");

		await result(host, session, { results: [{ index: 0, runId: "run-1", sessionFile: "/x/child.jsonl", model: "acme/mid" }] });
		const link = host.entries.find((e) => e.customType === "pi-switchboard.link")?.data;
		assert.deepEqual(link.links[0], { decisionId: launch.id, taskIndex: 0, runId: "run-1", sessionFile: "/x/child.jsonl", model: "acme/mid" });

		await host.fire("session_shutdown", { type: "session_shutdown" }, session.ctx);
		assert.equal((globalThis as { __switchboardTest?: { disposed?: boolean } }).__switchboardTest?.disposed, true, "the registration is released");
	});

	it("never routes an external-runner agent or a call that names a model", async () => {
		const { host, session, decisions } = await boot({ subagents: {} });
		const external: Record<string, any> = { agent: "codex-exec", task: "x" };
		await call(host, session, external);
		const named: Record<string, any> = { agent: "scout", task: "y", model: "other/explicit" };
		await call(host, session, named, "call-2");
		assert.equal(external.model, undefined);
		assert.equal(named.model, "other/explicit");
		assert.equal(external.options, undefined, "no binding for a call pi-subagents would reject it on");
		assert.deepEqual(
			decisions()
				.filter((d) => d.reason === "launch")
				.map((d) => d.subagent.mode),
			["skipped", "skipped"],
		);
	});

	it("falls back to physical members and leases them until a foreground call returns", async () => {
		const { host, session, tier } = await boot({ subagents: {}, config: { subagents: { mode: "launch", agents: {} } } });
		const input: Record<string, any> = { agent: "scout", task: "scan the repo" };
		await call(host, session, input);
		assert.equal(input.model, "acme/mid:medium", "a physical member from the tier's strategy");
		await tier("health");
		assert.match(session.notices.at(-1)?.message ?? "", /work\/standard acme\/mid: ok, 1 in flight/u);
		await result(host, session, { results: [{ index: 0, runId: "r" }] });
		await tier("health");
		assert.doesNotMatch(session.notices.at(-1)?.message ?? "", /1 in flight/u);

		const background: Record<string, any> = { agent: "scout", task: "scan again" };
		await call(host, session, background, "call-2");
		await result(host, session, { asyncId: "a1", results: [] }, "call-2");
		await tier("health");
		assert.match(session.notices.at(-1)?.message ?? "", /acme\/mid: ok, 1 in flight/u, "a background child keeps its lease until it expires");
	});
});

describe("inside a subagent child", () => {
	it("matches its launch decision from the binding and stamps it on its decisions and live status", async () => {
		const { taskDigest } = await import("../../src/subagents/binding.ts");
		const launches = [
			{ d: taskDigest("scout", "scan the repo"), a: "scout", id: "d_parent_1" },
			{ d: taskDigest("scout", "scan the tests"), a: "scout", id: "d_parent_2" },
		];
		const { host, session, route, decisions, agentDir } = await boot({
			header: { parentSession: "/sessions/parent.jsonl" },
			env: { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-switchboard/1": { parent: "/sessions/parent.jsonl", launches } }) },
		});
		const out = await route(routeRequest({ id: "work.light", text: "scan the repo", system: '<active_agent name="scout"/>\n\nYou scan.' }));
		assert.equal(out.model.id, "small", "the tier comes from the model the parent chose");
		const decision = decisions()[0];
		assert.deepEqual([decision.scope, decision.kind, decision.launchDecisionId], ["subagent", "launch-tier", "d_parent_1"]);
		assert.equal(session.classifierCalls.length, 0, "children do not classify a launch tier again");

		// Status writes are throttled to every 250 ms; shutdown flushes the final state.
		await host.fire("session_shutdown", { type: "session_shutdown" }, session.ctx);
		const live = join(agentDir, "pi-switchboard", "live");
		const [file] = readdirSync(live).filter((f) => f.endsWith(".json"));
		assert.ok(file);
		const status = JSON.parse(readFileSync(join(live, file), "utf8"));
		assert.deepEqual([status.parent, status.launchDecisionId, status.tier, status.status], ["/sessions/parent.jsonl", "d_parent_1", "light", "done"]);
	});
});
