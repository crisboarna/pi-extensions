import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { needsTosNotice, plannotatorModels, runChecks, TOS_WARNING, withoutTosWarnings } from "../../src/config/checks.ts";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { CatalogView, RawConfig } from "../../src/config/types.ts";

const files = (map: Record<string, unknown>) => (path: string) => (path in map ? JSON.stringify(map[path]) : undefined);

const base = (extra: Partial<RawConfig> = {}) =>
	normalizeConfig({ classifiers: [{ model: "local/judge" }], profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x"] } } } }, ...extra });

const input = (over: Partial<Parameters<typeof runChecks>[0]> = {}): Parameters<typeof runChecks>[0] => ({
	config: base(),
	agentDir: "/agent",
	cwd: "/work/repo",
	projectTrusted: true,
	classifierAvailable: () => true,
	classifierIsLocal: () => true,
	read: files({}),
	...over,
});

describe("Plannotator per-phase models", () => {
	it("applies layers in order and lets null clear an inherited model", () => {
		const layers = [
			{ file: "builtin", json: { defaults: { model: { provider: "p", id: "m1" } }, phases: { executing: { model: { provider: "p", id: "m2" } } } } },
			{ file: "global", json: { defaults: { model: null }, phases: { planning: { model: { provider: "p", id: "m3" } } } } },
			{ file: "project", json: { phases: { executing: { model: { provider: "p", id: "m4" } } } } },
		];
		assert.deepEqual(plannotatorModels(layers), [
			{ where: "planning", model: "p/m3", file: "global" },
			{ where: "executing", model: "p/m4", file: "project" },
		]);
	});

	it("warns for a model in the global or a trusted project file, and not for null", () => {
		const global = runChecks(input({ read: files({ "/agent/plannotator.json": { phases: { planning: { model: { provider: "acme", id: "big" } } } } }) }));
		assert.equal(global.length, 1);
		assert.match(global[0] ?? "", /sets acme\/big for planning in \/agent\/plannotator\.json.*Set that model to null/u);
		const project = { "/work/repo/.pi/plannotator.json": { defaults: { model: { provider: "acme", id: "big" } } } };
		assert.equal(runChecks(input({ read: files(project) })).length, 1);
		assert.equal(runChecks(input({ read: files(project), projectTrusted: false })).length, 0, "an untrusted project file is not read");
		assert.equal(runChecks(input({ read: files({ "/agent/plannotator.json": { phases: { planning: { model: null } } } }) })).length, 0);
	});
});

describe("multi-pass project restriction", () => {
	const restricted = (allowedSubs: unknown) => input({ read: files({ "/work/repo/.pi/multi-pass.json": { allowedSubs } }) });

	it("warns when allowedSubs does not list the virtual provider", () => {
		const [warning] = runChecks(restricted(["acme", "zen"]));
		assert.match(warning ?? "", /restricts this project with allowedSubs.*Add "switchboard"/u);
	});

	it("stays quiet when it lists the provider, is empty, or is absent", () => {
		assert.deepEqual(runChecks(restricted(["acme", "switchboard"])), []);
		assert.deepEqual(runChecks(restricted([])), []);
		assert.deepEqual(runChecks(input()), []);
	});

	it("follows a renamed virtual provider", () => {
		const config = base({ virtualModel: { provider: "router" } });
		assert.match(runChecks({ ...restricted(["acme"]), config })[0] ?? "", /Add "router"/u);
	});
});

describe("classifier checks", () => {
	it("warns about a classifier that is not registered, and about a remote one without allowRemote", () => {
		const missing = runChecks(input({ classifierAvailable: () => false }));
		assert.match(missing[0] ?? "", /not registered as a classifier or has no credentials/u);
		const remote = runChecks(input({ classifierIsLocal: () => false }));
		assert.match(remote[0] ?? "", /runs off this machine and is skipped.*allowRemote/u);
		const allowed = runChecks(input({ config: base({ classifiers: [{ model: "cloud/judge", allowRemote: true }] }), classifierIsLocal: () => false }));
		assert.deepEqual(allowed, []);
	});
});

describe("terms-of-service notice", () => {
	const catalog: CatalogView = { find: () => ({ contextWindow: 1 }), hasAuth: () => true, isProvider: (n) => ["acme"].includes(n) };

	it("applies to accountSiblings on, or to a tier that pools accounts, and not otherwise", () => {
		assert.equal(needsTosNotice(base()), false);
		assert.equal(needsTosNotice(base({ failover: { accountSiblings: "on" } })), true);
		const pooled = normalizeConfig({ profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x", "acme-2/x"] } } } } }, { catalog });
		assert.equal(needsTosNotice(pooled), true);
		assert.ok(pooled.warnings.some((w) => w.includes("may breach")));
		assert.deepEqual(withoutTosWarnings(pooled.warnings), [], "the notice moves to the one-time channel");
		assert.match(TOS_WARNING, /may breach that provider's terms/u);
	});
});
