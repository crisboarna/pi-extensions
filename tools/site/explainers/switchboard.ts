// pi-switchboard's rule playground for the site: typed answers go through the
// profile's real rules and tier decision, as /tier try does with typed
// answers. Pure: no classifier, no pi; the member a strategy would pick is
// left out, since it depends on live account health.
import { normalizeConfig } from "../../../packages/pi-switchboard/src/config/normalize.ts";
import type { RawConfig } from "../../../packages/pi-switchboard/src/config/types.ts";
import { evaluateRules, type RuleOutcome } from "../../../packages/pi-switchboard/src/rules/evaluate.ts";
import type { Answers, Condition } from "../../../packages/pi-switchboard/src/rules/types.ts";
import { decideUserTier, type TierDecision } from "../../../packages/pi-switchboard/src/tiering/decide.ts";

export interface PlaygroundQuestion {
	/** The text of pi-switchboard.json. */
	configText: string;
	/** The profile to route with; its default from profileSelection when absent. */
	profile?: string;
	answers: Answers;
}

export type PlaygroundAnswer =
	| {
			ok: true;
			profile: string;
			/** Every valid profile, for a picker. */
			profiles: string[];
			/** The labels the `work` question can answer with. */
			choices: string[];
			rules: Array<{ when: Condition | undefined; tier: string }>;
			outcome: RuleOutcome;
			decision: TierDecision;
			members: string[];
	  }
	| { ok: false; errors: string[] };

export function routeAnswers({ configText, profile: wanted, answers }: PlaygroundQuestion): PlaygroundAnswer {
	let raw: RawConfig;
	try {
		raw = JSON.parse(configText) as RawConfig;
	} catch (error) {
		return { ok: false, errors: [`pi-switchboard.json is not JSON: ${(error as Error).message}`] };
	}
	const config = normalizeConfig(raw);
	const name = wanted ?? config.profileSelection.default ?? Object.keys(config.profiles)[0];
	const invalid = name === undefined ? undefined : config.invalidProfiles[name];
	if (invalid) return { ok: false, errors: invalid.map((error) => `profile ${name}: ${error}`) };
	const profile = name === undefined ? undefined : config.profiles[name];
	if (!profile || name === undefined) return { ok: false, errors: ["the config has no valid profile"] };
	const threshold = profile.threshold ?? config.classifiers[0]?.threshold ?? config.classification.threshold;
	const outcome = evaluateRules(profile, config.classification.questions, answers, { $scope: "main", $planMode: "executing" }, threshold);
	const decision = decideUserTier({ profile, state: { downVotes: 0 }, outcome });
	const tier = profile.tiers.find((candidate) => candidate.name === decision.tier);
	const work = config.classification.questions.work;
	return {
		ok: true,
		profile: name,
		profiles: Object.keys(config.profiles),
		choices: work?.type === "choice" ? Object.keys(work.criteria) : [],
		rules: profile.ruleset.tierRules.map((rule) => ({ when: rule.when, tier: rule.tier })),
		outcome,
		decision,
		members: tier ? tier.members.map((member) => member.key) : [],
	};
}
