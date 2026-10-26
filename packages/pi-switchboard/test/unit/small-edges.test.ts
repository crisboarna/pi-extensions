import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mergeProposal, profileName, proposeConfig, rankModels } from "../../src/autotier/propose.ts";
import { mergeProject, readJson } from "../../src/config/load.ts";
import type { RawConfig } from "../../src/config/types.ts";
import { accountLabel, readMultiPassSubscriptions } from "../../src/selection/accounts.ts";
import { classifyError, parseRetryHeaders } from "../../src/selection/errors.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { recordFailure } from "../../src/selection/select.ts";

describe("project config merge", () => {
	it("merges rulesets and per-agent limits, and warns about other subagent settings", () => {
		const user: RawConfig = {
			rulesets: { a: { tierRules: [{ tier: "@top" }] } },
			subagents: { enabled: true, agents: { scout: { maxTier: "light" } } },
			profileSelection: { default: "work" },
		};
		const project: RawConfig = {
			rulesets: { b: { tierRules: [{ tier: "@bottom" }] } },
			subagents: { enabled: false, mode: "launch", agents: { worker: { minTier: "deep" } } },
			profileSelection: { rules: [{ profile: "work", matchModel: "x" }] },
		};
		const { merged, warnings } = mergeProject(user, project, "/repo/.pi/pi-switchboard.json");
		assert.deepEqual(Object.keys(merged.rulesets ?? {}), ["a", "b"]);
		assert.deepEqual(merged.subagents, { enabled: true, agents: { scout: { maxTier: "light" }, worker: { minTier: "deep" } } });
		assert.deepEqual(merged.profileSelection, { default: "work", rules: [{ profile: "work", matchModel: "x" }] });
		assert.deepEqual(warnings, ["/repo/.pi/pi-switchboard.json: only subagents.agents can be set in a project file (ignored: enabled, mode)"]);
		assert.equal(mergeProject(user, { subagents: { mode: "child" } }, "p").merged.subagents, user.subagents);
	});

	it("rejects a config file whose top level is not an object", () => {
		const path = join(mkdtempSync(join(tmpdir(), "switchboard-json-")), "c.json");
		writeFileSync(path, "[1, 2]");
		assert.match(readJson(path).error ?? "", /the top level must be an object/);
	});
});

describe("errors and failures", () => {
	it("treats an empty message as other and skips invalid user patterns", () => {
		assert.equal(classifyError(undefined), "other");
		assert.equal(classifyError("weird failure", { quota: ["(unclosed", "weird"] }), "quota");
	});

	it("reads retry-after as an HTTP date", () => {
		assert.equal(parseRetryHeaders({ "Retry-After": "Mon, 26 Oct 2026 13:00:00 GMT" }, 0), Date.UTC(2026, 9, 26, 13));
		assert.equal(parseRetryHeaders({ "retry-after": "soon" }, 0), undefined);
	});

	it("benches a member on an auth failure and keeps it for unknown classes", () => {
		const store = new MemoryHealthStore();
		const now = Date.UTC(2026, 9, 26);
		const auth = recordFailure(store, "acme/mid", "auth", undefined, now);
		assert.deepEqual([auth.switchMember, auth.why.startsWith("authentication failed")], [true, true]);
		const other = recordFailure(store, "acme/mid", "context-overflow", undefined, now);
		assert.deepEqual(other, { switchMember: false, why: "context-overflow error; keeping the member" });
	});
});

describe("multi-pass accounts", () => {
	it("reads labels from multi-pass.json, adds MULTI_SUB accounts, and skips malformed entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-accounts-"));
		writeFileSync(
			join(dir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "acme", index: 2, label: "work" }, { provider: "acme", index: 3 }, { provider: 1 }, null] }),
		);
		const subscriptions = readMultiPassSubscriptions(dir, { MULTI_SUB: "acme:3, zen:2, broken, :4, bad:x" });
		assert.deepEqual(subscriptions, [
			{ provider: "acme", index: 2, label: "work" },
			{ provider: "acme", index: 3 },
			{ provider: "zen", index: 2 },
		]);
		const isProvider = (name: string) => ["acme", "acme-2", "acme-3"].includes(name);
		assert.deepEqual(
			["acme", "acme-2", "acme-3"].map((p) => accountLabel(p, subscriptions, isProvider)),
			["#1", "work", "#3"],
		);
		assert.deepEqual(readMultiPassSubscriptions(join(dir, "missing"), {}), []);
	});
});

describe("auto-tier proposals", () => {
	it("orders unpriced models by hints, then context window, output limit and id", () => {
		const ranked = rankModels([
			{ provider: "p", id: "b", contextWindow: 100, maxTokens: 10 },
			{ provider: "p", id: "a", contextWindow: 100, maxTokens: 10 },
			{ provider: "p", id: "c", contextWindow: 100, maxTokens: 5 },
			{ provider: "p", id: "d", contextWindow: 50 },
			{ provider: "p", id: "e" },
		]);
		assert.deepEqual(
			ranked.map((m) => m.id),
			["e", "d", "c", "a", "b"],
		);
		assert.equal(profileName("---"), "profile");
	});

	it("keeps existing profiles, rules and default when merging a proposal", () => {
		const proposal = proposeConfig([
			{ provider: "acme", id: "small" },
			{ provider: "zen", id: "big" },
		]);
		assert.equal(proposal.profiles?.all?.fallbackTier, undefined, "two models make light and deep tiers only");
		const merged = mergeProposal({ profiles: { acme: { tiers: {} } }, profileSelection: { rules: [{ profile: "acme", matchProvider: "x" }] } }, proposal);
		assert.deepEqual(merged.profiles?.acme, { tiers: {} });
		assert.deepEqual(
			merged.profileSelection?.rules?.map((r) => r.profile),
			["acme", "zen"],
		);
		assert.equal(merged.profileSelection?.default, "acme");
		assert.deepEqual(mergeProposal({}, {}), { profiles: {}, profileSelection: { rules: [] } });
	});
});
