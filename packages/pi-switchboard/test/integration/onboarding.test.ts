import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { routeRequest } from "../support/fake-pi.ts";
import { BASE_CONFIG, boot } from "../support/harness.ts";

const last = (session: { notices: Array<{ message: string }> }) => session.notices.at(-1)?.message ?? "";

describe("first run", () => {
	it("explains what to do once when there is no config, and never again", async () => {
		const first = await boot({ noConfig: true });
		const notice = first.session.notices.find((n) => n.message.startsWith("pi-switchboard is installed but not configured"));
		assert.ok(notice, "the first-run notice is shown");
		assert.match(notice.message, /\/tier init.*\/tier tour.*\/tier doctor/);
		const state = JSON.parse(readFileSync(join(first.agentDir, "pi-switchboard", "state.json"), "utf8"));
		assert.equal(state.warned.firstRun, true);
		await first.host.fire("session_start", { type: "session_start", reason: "reload" }, first.session.ctx);
		assert.equal(first.session.notices.filter((n) => n.message.startsWith("pi-switchboard is installed")).length, 1);
	});

	it("does not show the notice when a config exists", async () => {
		const { session } = await boot();
		assert.ok(!session.notices.some((n) => n.message.startsWith("pi-switchboard is installed")));
	});
});

describe("/tier try", () => {
	it("previews with the classifier without recording anything", async () => {
		const { session, tier, host } = await boot({ scenario: "plan" });
		await tier("try design the billing service");
		const text = last(session);
		assert.match(text, /^\/tier try: "design the billing service"/);
		assert.match(text, /\[local\/judge, \d+ ms\]/);
		assert.match(text, /tier: deep/);
		assert.match(text, /model: acme\/big:high/);
		assert.equal(host.entries.filter((e) => e.customType === "pi-switchboard.decision").length, 0, "no decision is recorded");
	});

	it("uses typed answers, reports bad ones, and explains its usage", async () => {
		const { session, tier } = await boot({ scenario: "fail" });
		await tier("try work=mechanical depth=0.2 risky=no rename foo");
		assert.match(last(session), /\[typed answers\]/);
		assert.match(last(session), /tier: light/);
		await tier("try work=dance x");
		assert.match(last(session), /^\/tier try: work expects one of/);
		await tier("try");
		assert.match(last(session), /^Usage: \/tier try/);
		await tier("try fix the build");
		assert.match(last(session), /The classifier did not answer/);
	});

	it("says why when nothing can route", async () => {
		const { session, tier } = await boot({ config: { profiles: {}, profileSelection: {} } });
		await tier("try anything");
		assert.match(last(session), /^\/tier try: pi-switchboard is inactive/);
	});
});

describe("/tier doctor and /tier tour", () => {
	it("checks the setup, probing the classifier and reading the footer settings", async () => {
		const { session, tier, agentDir } = await boot({
			config: { ...BASE_CONFIG, profiles: { work: { tiers: { only: { rank: 1, members: ["acme/mid"], strategy: "quota-headroom" } } } } },
		});
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@narumitw/pi-usage"], powerline: { customItems: [{ id: "tier", statusKey: "tier" }] } }),
		);
		await tier("doctor");
		const text = last(session);
		assert.match(text, /^pi-switchboard doctor: /);
		assert.match(text, /✓ classifier local\/judge answered in \d+ ms/);
		assert.match(text, /✓ the footer shows the tier/);
		assert.match(text, /✓ pi-usage provides quota for acme/);
		assert.match(text, /✓ profile work: 1 tiers, 1 members/);
	});

	it("reports a classifier that does not answer and a powerline preset without extension statuses", async () => {
		const { session, tier, agentDir } = await boot({ scenario: "fail" });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-powerline-footer"], powerline: "minimal" }));
		await tier("doctor");
		assert.match(last(session), /✗ classifier local\/judge did not answer \(connection refused\)/);
		assert.match(last(session), /! the footer does not show the tier/);
	});

	it("prints the tour without the TUI", async () => {
		const { session, tier } = await boot();
		await tier("tour");
		assert.match(last(session), /^1\/5 What pi-switchboard does[\s\S]*5\/5 Where to look/);
	});

	it("routes normally after a preview", async () => {
		const { route, tier, decisions } = await boot({ scenario: "plan" });
		await tier("try design it");
		const out = await route(routeRequest({ text: "design the billing service" }));
		assert.equal(out.model.id, "big");
		assert.equal(decisions().length, 1);
		assert.equal(decisions()[0].task, 1, "the preview did not advance the task counter");
	});
});
