import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, mergeProject } from "../../src/config/load.ts";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { CatalogView, RawConfig } from "../../src/config/types.ts";

const EXAMPLES = join(import.meta.dirname, "..", "..", "examples");
const example = (name: string): RawConfig => JSON.parse(readFileSync(join(EXAMPLES, name), "utf8"));

/** A catalog where every model exists with credentials, except those listed. */
function catalog(options: { missing?: string[]; noAuth?: string[]; windows?: Record<string, number>; providers?: string[] } = {}): CatalogView {
	return {
		find: (provider, id) =>
			options.missing?.includes(`${provider}/${id}`) ? undefined : { contextWindow: options.windows?.[`${provider}/${id}`] ?? 200_000 },
		hasAuth: (provider) => !options.noAuth?.includes(provider),
		isProvider: (name) => (options.providers ?? ["acme", "zen"]).includes(name),
	};
}

const tiny = (tiers: Record<string, unknown>, extra: Record<string, unknown> = {}): RawConfig =>
	({ profiles: { p: { tiers, ...extra } } }) as unknown as RawConfig;

describe("examples", () => {
	for (const file of ["two-subscriptions.json", "mixed-providers.json", "local-only.json", "single-tier.json"]) {
		it(`${file} normalizes without invalid profiles`, () => {
			const config = normalizeConfig(example(file), { catalog: catalog() });
			assert.deepEqual(config.invalidProfiles, {});
			assert.ok(Object.keys(config.profiles).length > 0);
		});
	}

	it("sorts tiers by rank and fills defaults", () => {
		const config = normalizeConfig(example("mixed-providers.json"), { catalog: catalog() });
		const mixed = config.profiles.mixed;
		assert.ok(mixed);
		assert.deepEqual(
			mixed.tiers.map((tier) => tier.name),
			["intern", "clerk", "builder", "senior", "architect"],
		);
		assert.equal(mixed.fallbackTier, "builder");
		assert.equal(mixed.baselineTier, "builder");
		assert.equal(mixed.directTier, "clerk");
		assert.equal(mixed.rulesetName, "ladder");
		assert.equal(mixed.tiers[2]?.strategy.name, "round-robin");
		assert.equal(mixed.tiers[0]?.strategy.name, "sticky", "tiers without a strategy are sticky");
	});

	it("resolves default fallback to the upper middle and direct to the lowest rank", () => {
		const config = normalizeConfig(example("two-subscriptions.json"), { catalog: catalog() });
		const codex = config.profiles.codex;
		assert.equal(codex?.directTier, "light");
		const noFallback = normalizeConfig(tiny({ a: { rank: 1, members: ["acme/x"] }, b: { rank: 2, members: ["acme/y"] } }));
		assert.equal(noFallback.profiles.p?.fallbackTier, "b", "two tiers: @middle is the stronger one");
	});

	it("parses member thinking from the suffix and lets the field win", () => {
		const config = normalizeConfig(tiny({ a: { rank: 1, members: ["acme/x:high", { model: "acme/y:low", thinking: "medium" }] } }));
		const members = config.profiles.p?.tiers[0]?.members ?? [];
		assert.deepEqual(
			members.map((m) => [m.key, m.thinking]),
			[
				["acme/x:high", "high"],
				["acme/y:medium", "medium"],
			],
		);
	});
});

describe("validation", () => {
	it("disables only the broken profile when a rule names an unknown tier", () => {
		const config = normalizeConfig({
			rulesets: { bad: { tierRules: [{ when: { work: "plan" }, tier: "nope" }, { tier: "@middle" }] } },
			profiles: {
				broken: { ruleset: "bad", tiers: { a: { rank: 1, members: ["acme/x"] } } },
				fine: { tiers: { a: { rank: 1, members: ["acme/x"] } } },
			},
		} as unknown as RawConfig);
		assert.ok(config.profiles.fine);
		assert.match(config.invalidProfiles.broken?.join("\n") ?? "", /unknown tier "nope"/u);
	});

	it("requires exactly one trailing default rule", () => {
		const config = normalizeConfig(
			tiny({ a: { rank: 1, members: ["acme/x"] } }, { ruleset: { tierRules: [{ tier: "a" }, { when: { work: "plan" }, tier: "a" }] } }),
		);
		assert.match(config.invalidProfiles.p?.join("\n") ?? "", /default rule/u);
	});

	it("rejects conditions on unknown questions and labels", () => {
		const config = normalizeConfig(
			tiny(
				{ a: { rank: 1, members: ["acme/x"] } },
				{
					ruleset: { tierRules: [{ when: { mood: "happy" }, tier: "a" }, { when: { work: "dance" }, tier: "a" }, { tier: "a" }] },
				},
			),
		);
		const errors = config.invalidProfiles.p?.join("\n") ?? "";
		assert.match(errors, /unknown question "mood"/u);
		assert.match(errors, /no label "dance"/u);
	});

	it("reports rank collisions", () => {
		const config = normalizeConfig(tiny({ a: { rank: 1, members: ["acme/x"] }, b: { rank: 1, members: ["acme/y"] } }));
		assert.match(config.invalidProfiles.p?.join("\n") ?? "", /share a rank/u);
	});

	it("disables members missing from the catalog and keeps the profile when others remain", () => {
		const config = normalizeConfig(tiny({ a: { rank: 1, members: ["acme/gone", "acme/x"] } }), { catalog: catalog({ missing: ["acme/gone"] }) });
		const members = config.profiles.p?.tiers[0]?.members ?? [];
		assert.equal(members.find((m) => m.id === "gone")?.enabled, false);
		assert.ok(config.warnings.some((w) => w.includes("not in the model catalog")));
	});

	it("invalidates a profile whose tier has no usable member", () => {
		const config = normalizeConfig(tiny({ a: { rank: 1, members: ["zen/x"] } }), { catalog: catalog({ noAuth: ["zen"] }) });
		assert.match(config.invalidProfiles.p?.join("\n") ?? "", /no usable member .*no credentials/u);
	});

	it("warns about very different context windows and pooled accounts", () => {
		const config = normalizeConfig(tiny({ a: { rank: 1, members: ["acme/x", "acme-2/x", "zen/small"] } }), {
			catalog: catalog({ windows: { "zen/small": 8_000 } }),
		});
		assert.ok(config.warnings.some((w) => w.includes("context windows range")));
		assert.ok(config.warnings.some((w) => w.includes("pools 2 accounts of acme")));
	});

	it("rejects bad names and unknown strategies", () => {
		const config = normalizeConfig(tiny({ Big: { rank: 1, members: ["acme/x"], strategy: "telepathy" } }));
		const errors = config.invalidProfiles.p?.join("\n") ?? "";
		assert.match(errors, /tier names use lowercase/u);
		assert.match(errors, /unknown strategy "telepathy"/u);
	});
});

describe("project overrides", () => {
	const user: RawConfig = {
		classifiers: [{ model: "local/judge" }],
		profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x"] }, b: { rank: 2, members: ["acme/y"] } } } },
		profileSelection: { default: "p", rules: [{ matchProvider: "acme*", profile: "p" }] },
	};

	it("replaces tiers per tier, adds profiles and prepends selection rules", () => {
		const { merged, warnings } = mergeProject(
			user,
			{
				profile: "q",
				profiles: { p: { tiers: { b: { rank: 2, members: ["zen/z"] } } }, q: { tiers: { only: { rank: 1, members: ["zen/z"] } } } },
				profileSelection: { rules: [{ matchProvider: "zen*", profile: "q" }] },
			},
			"project",
		);
		assert.deepEqual(warnings, []);
		assert.deepEqual(Object.keys(merged.profiles?.p?.tiers ?? {}), ["a", "b"]);
		assert.deepEqual(merged.profiles?.p?.tiers.b?.members, ["zen/z"]);
		assert.equal(merged.profile, "q");
		assert.deepEqual(
			merged.profileSelection?.rules?.map((r) => r.profile),
			["q", "p"],
		);
	});

	it("never lets a project change classifiers", () => {
		const { merged, warnings } = mergeProject(user, { classifiers: [{ model: "remote/judge" }] } as RawConfig, "project");
		assert.deepEqual(merged.classifiers, [{ model: "local/judge" }]);
		assert.match(warnings.join(), /"classifiers" is ignored/u);
	});
});

describe("loadConfig", () => {
	function tree() {
		const root = mkdtempSync(join(tmpdir(), "switchboard-config-"));
		const agentDir = join(root, "agent");
		const project = join(root, "work", "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		return { root, agentDir, project };
	}

	it("reports a missing config", () => {
		const { root, agentDir, project } = tree();
		const loaded = loadConfig({ agentDir, cwd: project, projectTrusted: true, home: root });
		assert.equal(loaded.missing, true);
		assert.deepEqual(loaded.config.profiles, {});
	});

	it("applies a trusted project file and ignores an untrusted one", () => {
		const { root, agentDir, project } = tree();
		writeFileSync(join(agentDir, "pi-switchboard.json"), JSON.stringify({ profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x"] } } } } }));
		writeFileSync(join(project, ".pi", "pi-switchboard.json"), JSON.stringify({ profile: "p" }));
		const trusted = loadConfig({ agentDir, cwd: join(project, "src"), projectTrusted: true, home: root });
		assert.equal(trusted.config.projectProfile, "p");
		assert.equal(trusted.config.sources.length, 2);
		const untrusted = loadConfig({ agentDir, cwd: project, projectTrusted: false, home: root });
		assert.equal(untrusted.config.projectProfile, undefined);
		assert.ok(untrusted.config.warnings.some((w) => w.includes("not trusted")));
	});

	it("reports JSON syntax errors as warnings", () => {
		const { root, agentDir, project } = tree();
		writeFileSync(join(agentDir, "pi-switchboard.json"), "{ nope");
		const loaded = loadConfig({ agentDir, cwd: project, projectTrusted: true, home: root });
		assert.ok(loaded.config.warnings.some((w) => w.includes("pi-switchboard.json")));
	});
});
