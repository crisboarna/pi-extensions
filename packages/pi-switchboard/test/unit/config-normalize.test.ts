import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_QUESTIONS } from "../../src/classifier/questions.ts";
import { normalizeConfig, validateRuleset } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";

const raw = (value: unknown): RawConfig => value as RawConfig;
const oneTier = (tier: Record<string, unknown> = {}, profile: Record<string, unknown> = {}): RawConfig =>
	raw({ profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x"], ...tier } }, ...profile } } });
const errorsOf = (config: ReturnType<typeof normalizeConfig>, name = "p") => config.invalidProfiles[name]?.join("\n") ?? "";

describe("settings", () => {
	it("keeps every explicit setting", () => {
		const config = normalizeConfig(
			raw({
				version: 1,
				classification: {
					threshold: 0.7,
					decisionBudgetMs: 900,
					temperature: 0.2,
					evidence: { maxTokens: 900, requestTokens: 300, toolErrors: { max: 2, chars: 80 }, redact: ["secret-\\d+"] },
				},
				subagents: { profile: "p" },
				metrics: { piUsage: "off", ledger: { retainDays: 3 } },
				autoTier: { nameHints: { small: ["mini"], large: ["max"] } },
				live: { mirror: false, toolResultBytes: 10, retainHours: 2 },
				ui: { navigator: { shortcut: "ctrl+x", refreshMs: 100, widget: "off" }, status: "{tier}", statusSub: "{model}", entries: "expanded" },
				debug: { log: true, fullEvidence: true, maxBytes: 1000, maxFiles: 2 },
				budgets: { session: { costUsd: 5 } },
				profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x"] } } } },
			}),
		);
		assert.equal(config.classification.threshold, 0.7);
		assert.equal(config.classification.decisionBudgetMs, 900);
		assert.equal(config.classification.temperature, 0.2);
		assert.deepEqual(config.classification.evidence, { maxTokens: 900, requestTokens: 300, toolErrors: { max: 2, chars: 80 }, redact: ["secret-\\d+"] });
		assert.equal(config.subagents.profile, "p");
		assert.deepEqual(config.metrics, { piUsage: "off", ledgerRetainDays: 3 });
		assert.deepEqual(config.autoTier.nameHints, { small: ["mini"], large: ["max"] });
		assert.deepEqual(config.live, { mirror: false, toolResultBytes: 10, retainHours: 2 });
		assert.deepEqual(config.ui, {
			navigator: { shortcut: "ctrl+x", refreshMs: 100, widget: "off" },
			status: "{tier}",
			statusSub: "{model}",
			entries: "expanded",
		});
		assert.deepEqual(config.debug, { log: true, fullEvidence: true, maxBytes: 1000, maxFiles: 2 });
		assert.deepEqual(config.budgets, { session: { costUsd: 5 } });
		assert.deepEqual(config.warnings, []);
	});

	it("fills defaults inside sections that are present but empty", () => {
		const config = normalizeConfig(
			raw({
				classification: { evidence: { toolErrors: {} } },
				metrics: { ledger: {} },
				autoTier: { nameHints: {} },
				live: {},
				ui: { navigator: {} },
				debug: {},
				profiles: { p: { tiers: { a: { rank: 1, members: ["acme/x"] } }, hysteresis: {}, escalation: {} } },
			}),
		);
		const defaults = normalizeConfig(oneTier());
		assert.deepEqual(config.classification, defaults.classification);
		assert.deepEqual(config.metrics, defaults.metrics);
		assert.deepEqual(config.live, defaults.live);
		assert.deepEqual(config.ui, defaults.ui);
		assert.deepEqual(config.debug, defaults.debug);
		assert.deepEqual(config.profiles.p?.escalation, defaults.profiles.p?.escalation);
		assert.equal(config.profiles.p?.hysteresis.downTurns, defaults.profiles.p?.hysteresis.downTurns);
		assert.equal(config.classification.temperature, undefined);
	});

	it("warns about an unknown version, a reserved ruleset name and an unknown subagents profile", () => {
		const config = normalizeConfig(
			raw({ version: 2, rulesets: { builtin: { tierRules: [{ tier: "@top" }] } }, subagents: { profile: "ghost" }, ...oneTier() }),
		);
		assert.match(config.warnings.join("\n"), /unknown config version 2/);
		assert.match(config.warnings.join("\n"), /the ruleset name "builtin" is reserved/);
		assert.match(config.warnings.join("\n"), /subagents.profile names unknown or invalid profile "ghost"/);
	});
});

describe("questions", () => {
	it('uses the built-in questions for "builtin" and a custom map as given', () => {
		assert.equal(normalizeConfig(raw({ classification: { questions: "builtin" } })).classification.questions, BUILTIN_QUESTIONS);
		const custom = { size: { type: "bool", instructions: "Big?", criteria: { true: "yes", false: "no" } } };
		assert.deepEqual(normalizeConfig(raw({ classification: { questions: custom } })).classification.questions, custom);
	});

	it("falls back to the built-in questions with a warning for an empty or invalid map", () => {
		for (const questions of [{}, "nonsense", 3]) {
			const config = normalizeConfig(raw({ classification: { questions } }));
			assert.equal(config.classification.questions, BUILTIN_QUESTIONS);
			assert.match(config.warnings.join("\n"), /classification.questions must be "builtin" or a non-empty map/);
		}
	});
});

describe("members", () => {
	it("rejects members without a model, with a bad reference or a bad thinking level", () => {
		const config = normalizeConfig(oneTier({ members: [{ weight: 2 }, "not-a-ref", { model: "acme/y", thinking: "ultra" }, "acme/x"] }));
		const errors = errorsOf(config);
		assert.match(errors, /member 1 needs a "model" string/);
		assert.match(errors, /"not-a-ref" is not a provider\/model reference/);
		assert.match(errors, /"ultra" is not a thinking level/);
	});

	it("rejects a member listed twice", () => {
		assert.match(errorsOf(normalizeConfig(oneTier({ members: ["acme/x", "acme/x"] }))), /member "acme\/x" is listed twice/);
	});

	it("keeps weights, tags, schedules, budgets and the disabled flag", () => {
		const schedule = [{ from: "09:00", to: "17:00" }];
		const budget = { window: "1d", tokens: 100 };
		const config = normalizeConfig(
			oneTier({
				members: [
					{ model: "acme/x", weight: 3, tags: ["fast"], schedule, budget },
					{ model: "acme/y", weight: -1, enabled: false },
				],
			}),
		);
		const [first, second] = config.profiles.p?.tiers[0]?.members ?? [];
		assert.equal(first?.weight, 3);
		assert.deepEqual(first?.tags, ["fast"]);
		assert.deepEqual(first?.schedule, schedule);
		assert.deepEqual(first?.budget, budget);
		assert.equal(second?.weight, 1);
		assert.deepEqual(second?.tags, []);
		assert.equal(second?.disabledReason, "disabled in config");
	});
});

describe("tiers and strategies", () => {
	it("rejects a tier that is not an object or has a fractional rank", () => {
		const config = normalizeConfig(raw({ profiles: { p: { tiers: { a: "nope", b: { rank: 1.5, members: ["acme/x"] } } } } }));
		assert.match(errorsOf(config), /tier "?a"?: must be an object|a: must be an object/);
		assert.match(errorsOf(config), /rank must be an integer/);
	});

	it("keeps a tier's affinity", () => {
		const affinity = { scope: "task", ttlMs: 1000 };
		assert.deepEqual(normalizeConfig(oneTier({ affinity })).profiles.p?.tiers[0]?.affinity, affinity);
	});

	it("rejects a custom fallback, an unknown fallback and a custom strategy without a module", () => {
		const custom = normalizeConfig(oneTier({ strategy: { name: "ordered", fallback: "custom" } }));
		assert.match(errorsOf(custom), /fallback strategy "custom" is not allowed/);
		const unknown = normalizeConfig(oneTier({ strategy: { name: "ordered", fallback: "telepathy" } }));
		assert.match(errorsOf(unknown), /fallback strategy "telepathy" is not allowed/);
		const noModule = normalizeConfig(oneTier({ strategy: { name: "custom" } }));
		assert.match(errorsOf(noModule), /the custom strategy needs a module path/);
	});

	it("keeps a custom strategy's module and a profile-wide strategy", () => {
		const config = normalizeConfig(oneTier({ strategy: { name: "custom", module: "./pick.mjs" } }));
		assert.equal(config.profiles.p?.tiers[0]?.strategy.module, "./pick.mjs");
		const profileWide = normalizeConfig(oneTier({}, { strategy: "round-robin" }));
		assert.equal(profileWide.profiles.p?.tiers[0]?.strategy.name, "round-robin");
	});
});

describe("profiles", () => {
	it("rejects a profile without tiers and a bad name", () => {
		const config = normalizeConfig(raw({ profiles: { Bad_Name: { tiers: {} }, empty: "x" } }));
		assert.match(errorsOf(config, "Bad_Name"), /profile names use lowercase/);
		assert.match(errorsOf(config, "Bad_Name"), /needs at least one tier/);
		assert.match(errorsOf(config, "empty"), /needs at least one tier/);
	});

	it("checks the threshold range and keeps a valid threshold and budgets", () => {
		assert.match(errorsOf(normalizeConfig(oneTier({}, { threshold: 1.5 }))), /threshold must be in \(0, 1\]/);
		assert.match(errorsOf(normalizeConfig(oneTier({}, { threshold: 0 }))), /threshold must be in \(0, 1\]/);
		const config = normalizeConfig(oneTier({}, { threshold: 0.6, budgets: { task: { tokens: 10 } } }));
		assert.equal(config.profiles.p?.threshold, 0.6);
		assert.deepEqual(config.profiles.p?.budgets, { task: { tokens: 10 } });
	});

	it("warns about selection rules that name unknown profiles or match nothing, and an unknown default", () => {
		const config = normalizeConfig(
			raw({
				...oneTier(),
				profileSelection: {
					default: "ghost",
					rules: [{ profile: "ghost", matchProvider: "acme" }, { profile: "p" }, { profile: "p", matchModel: "x" }],
				},
			}),
		);
		const warnings = config.warnings.join("\n");
		assert.match(warnings, /profileSelection rule names unknown profile "ghost"/);
		assert.match(warnings, /profileSelection rule for "p" has no matchProvider or matchModel/);
		assert.match(warnings, /profileSelection.default names unknown profile "ghost"/);
		assert.deepEqual(config.profileSelection.rules, [{ profile: "p", matchModel: "x" }]);
	});

	it("drops classifier entries without a model reference", () => {
		const config = normalizeConfig(raw({ ...oneTier(), classifiers: [{ model: "nope" }, { timeoutMs: 5 }, { model: "local/judge" }] }));
		assert.deepEqual(
			config.classifiers.map((entry) => entry.model),
			["local/judge"],
		);
		assert.equal(config.warnings.filter((warning) => /needs a provider\/model reference/.test(warning)).length, 2);
	});
});

describe("validateRuleset", () => {
	const tiers = ["low", "high"];
	it("needs a non-empty tierRules list", () => {
		assert.deepEqual(validateRuleset({ tierRules: [] }, tiers, BUILTIN_QUESTIONS), ["a ruleset needs a non-empty tierRules list"]);
		assert.deepEqual(validateRuleset("x" as never, tiers, BUILTIN_QUESTIONS), ["a ruleset needs a non-empty tierRules list"]);
	});

	it("reports non-string targets and floor rules without or with bad conditions", () => {
		const errors = validateRuleset(
			{
				tierRules: [{ when: { work: "plan" }, tier: 3 as never }, { tier: "low" }],
				floorRules: [{ atLeast: "high" } as never, { when: { color: "red" }, atLeast: "@top" }],
			},
			tiers,
			BUILTIN_QUESTIONS,
		);
		assert.ok(errors.includes("tier rule 1: target must be a string"));
		assert.ok(errors.includes('floor rule 1: needs a "when" condition'));
		assert.ok(errors.some((error) => error.startsWith("floor rule 2: ")));
	});
});
