import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { routeRequest } from "../support/fake-pi.ts";
import { BASE_CONFIG, boot } from "../support/harness.ts";

type Completion = { value: string; label: string };
const last = (session: { notices: Array<{ message: string; type?: string }> }) => session.notices.at(-1)?.message ?? "";
const usage = (input: number, cost: number) => ({ input, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });

describe("/tier status, profiles, pins and logs", () => {
	it("shows the status before and after decisions", async () => {
		const { session, route, tier } = await boot();
		await tier("");
		assert.match(last(session), /pi-switchboard routing/);
		assert.match(last(session), /profile: work \(default\) · tiers light < standard < deep/);
		assert.match(last(session), /classifiers: local\/judge/);
		await route(routeRequest());
		await tier("status");
		assert.match(last(session), /⇄ task 1/);
	});

	it("lists, sets and clears the session and global profile", async () => {
		const { session, tier } = await boot({ config: { ...BASE_CONFIG, profiles: { ...BASE_CONFIG.profiles, other: BASE_CONFIG.profiles.work } } });
		await tier("profile");
		assert.match(last(session), /profiles: work, other/);
		await tier("profile ghost");
		assert.deepEqual(session.notices.at(-1), { message: 'Unknown profile "ghost"', type: "error" });
		await tier("profile other");
		assert.match(last(session), /Profile set to other for this session/);
		await tier("profile auto");
		assert.match(last(session), /Profile selection restored for this session/);
		await tier("profile other --global");
		assert.match(last(session), /Profile set to other globally/);
		await tier("profile auto --global");
		assert.match(last(session), /Profile selection restored globally/);
	});

	it("pins with subagents, turns dry-run off, and logs and explains decisions", async () => {
		const { session, route, tier, decisions } = await boot();
		await tier("log");
		assert.match(last(session), /No decisions on this branch yet/);
		await tier("explain");
		assert.match(last(session), /No decision $/);
		await tier("pin deep --subagents");
		assert.match(last(session), /Pinned to deep \(subagents too\)/);
		await tier("status");
		assert.match(last(session), /pin: deep \(with subagents\)/);
		await tier("dry-run off");
		assert.match(last(session), /Dry-run off/);
		await route(routeRequest());
		const id = decisions().at(-1).id as string;
		await tier("log abc");
		assert.match(last(session), new RegExp(id.slice(-6)));
		await tier(`explain ${id.slice(-4)}`);
		assert.match(last(session), new RegExp(`^${id}`));
		await tier("explain nothing-like-it");
		assert.match(last(session), /No decision nothing-like-it/);
	});

	it("rejects an unknown subcommand", async () => {
		const { session, tier } = await boot();
		await tier("frobnicate");
		assert.deepEqual(session.notices.at(-1)?.type, "error");
		assert.match(last(session), /Unknown \/tier subcommand "frobnicate"\. Try: init, try, doctor, tour, models/);
	});

	it("completes subcommands and their arguments", async () => {
		const { host } = await boot();
		const command = host.commands.get("tier") as unknown as { getArgumentCompletions(prefix: string): Completion[] };
		assert.deepEqual(
			command.getArgumentCompletions("pr").map((c) => c.value),
			["profile"],
		);
		assert.deepEqual(
			command.getArgumentCompletions("profile ").map((c) => c.label),
			["auto", "work", "--global"],
		);
		assert.deepEqual(
			command.getArgumentCompletions("pin @").map((c) => c.value),
			["pin @top", "pin @middle", "pin @bottom"],
		);
		assert.deepEqual(
			command.getArgumentCompletions("dry-run o").map((c) => c.label),
			["on", "off"],
		);
		assert.deepEqual(command.getArgumentCompletions("log 1"), []);
	});
});

describe("/tier health, report and budget", () => {
	it("shows cooldowns, disabled members, requests in flight and latency", async () => {
		const config = {
			...BASE_CONFIG,
			profiles: {
				work: {
					tiers: {
						light: { rank: 1, members: ["acme/small:low", { model: "acme/mini", enabled: false }] },
						standard: { rank: 2, members: ["acme/mid", "zen/mid"], strategy: "ordered" },
					},
					fallbackTier: "standard",
				},
			},
		};
		const { session, route, tier, host } = await boot({ config });
		const first = await route(routeRequest());
		await route(
			routeRequest({
				reason: "retry",
				state: first.state,
				failed: { model: { provider: "acme", id: "mid" }, message: { errorMessage: "429 Too Many Requests. Retry-After: 30" } },
			}),
		);
		await host.fire(
			"message_end",
			{ message: { role: "assistant", provider: "zen", model: "mid", stopReason: "stop", content: [], usage: usage(100, 0.001) } },
			session.ctx,
		);
		await tier("health");
		const text = last(session);
		assert.match(text, /work\/standard acme\/mid: cooling down until .* \(rate limit\)/);
		assert.match(text, /work\/light acme\/mini: disabled: disabled in config/);
		assert.match(text, /work\/standard zen\/mid: ok/);
	});

	it("reports cost by tier, model and task, and the calibration", async () => {
		const { session, route, tier, host } = await boot();
		await route(routeRequest());
		await host.fire(
			"message_end",
			{ message: { role: "assistant", provider: "acme", model: "mid", stopReason: "stop", content: [], usage: usage(500, 0.004) } },
			session.ctx,
		);
		await route(routeRequest({ text: "rename foo to bar" }));
		await host.fire(
			"message_end",
			{ message: { role: "assistant", provider: "zen", model: "mid", stopReason: "stop", content: [], usage: usage(800, 0.25) } },
			session.ctx,
		);
		await tier("report");
		const text = last(session);
		assert.match(text, /Session: 2 routed responses, \$0\.25/);
		assert.match(text, /By tier:\n {2}standard: \$0\.25, 1340 tokens, 2 responses/);
		assert.match(text, /By model:\n {2}zen\/mid: \$0\.25, 820 tokens, 1 response\n {2}acme\/mid: \$0\.0040, 520 tokens, 1 response/);
		assert.match(text, /Calibration: 2 classified, 0 fallbacks \(0%\)/);
		assert.match(text, /≥0\.9: 2/);
	});

	it("shows spend against budgets, and says when there are none", async () => {
		const withBudgets = await boot({ config: { ...BASE_CONFIG, budgets: { task: { tokens: 1000 }, session: { costUsd: 2 } } } });
		await withBudgets.route(routeRequest());
		await withBudgets.host.fire(
			"message_end",
			{ message: { role: "assistant", provider: "acme", model: "mid", stopReason: "stop", content: [], usage: usage(300, 0.1) } },
			withBudgets.session.ctx,
		);
		await withBudgets.tier("budget");
		assert.match(last(withBudgets.session), /task: 320 tokens, \$0\.10 \(budget 1000 tokens, \$-\)/);
		assert.match(last(withBudgets.session), /session: 320 tokens, \$0\.10 \(budget - tokens, \$2\)/);
		const without = await boot();
		await without.tier("budget");
		assert.match(last(without.session), /No budgets configured/);
	});
});

describe("/tier handlers registered by the extension", () => {
	it("writes the inspector for the session", async () => {
		const { session, route, tier, dir } = await boot();
		await route(routeRequest());
		const out = join(dir, "inspect.html");
		await tier(`inspect -o ${out}`);
		assert.match(last(session), new RegExp(`Inspector written to ${out}$`));
		assert.match(readFileSync(out, "utf8"), /<title>/);
	});

	it("explains that the navigator needs the TUI", async () => {
		const { session, tier } = await boot();
		await tier("watch");
		assert.match(last(session), /The navigator needs the interactive TUI/);
	});

	it("proposes a config from the signed-in models and saves it after confirmation", async () => {
		const { session, tier, dir } = await boot();
		const asked: string[] = [];
		session.ctx.ui.confirm = async (title: string) => {
			asked.push(title);
			return true;
		};
		await tier("init");
		// PI_SWITCHBOARD_CONFIG points the user config at the test's file.
		const path = join(dir, "pi-switchboard.json");
		assert.equal(asked.length, 1);
		assert.match(last(session), /^Saved /);
		assert.ok(Object.keys(JSON.parse(readFileSync(path, "utf8")).profiles ?? {}).length > 1, "the proposal adds profiles next to the existing one");
	});

	it("opens the tier editor for the global config and leaves it unchanged when closed", async () => {
		const { session, tier, agentDir } = await boot();
		session.ctx.ui.select = async () => undefined;
		await tier("models --global");
		assert.equal(existsSync(join(agentDir, "pi-switchboard.json")), false);
	});
});
