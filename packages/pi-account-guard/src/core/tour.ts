import type { AccountKey } from "./account.ts";
import { blockDialog } from "./block-dialog.ts";
import { checkText } from "./check.ts";
import { DEFAULT_CONFIG, type GuardConfig } from "./config.ts";
import { decide, type PlaceOutcome } from "./decide.ts";
import { CHECK_USAGE, PLACE_ADD_USAGE, TAG_USAGE } from "./guard-command.ts";
import { resolvePlaceZone } from "./place.ts";

/**
 * `/guard tour`: four short steps over sample accounts and places, so a new
 * user sees what the guard checks and where to look before a turn is ever
 * blocked. The samples go through the guard's own checks; the tour writes
 * nothing and changes no state.
 */
export interface TourStep {
	title: string;
	lines: string[];
}

const HOME = "/home/me";
const context = { home: HOME, configPath: `${HOME}/.pi/agent/account-guard.json` };
const acme: AccountKey = { provider: "acme", source: "oauth" };
const homelab: AccountKey = { provider: "homelab", source: "oauth" };
const SAMPLE: GuardConfig = {
	...DEFAULT_CONFIG,
	accounts: [
		{ ...acme, zones: ["work"] },
		{ ...homelab, zones: ["personal"] },
	],
	places: [{ remote: "*/acme-corp/*", zone: "work" }],
};
const REMOTES: Record<string, string[]> = { [`${HOME}/work/api`]: ["git@github.com:acme-corp/api.git"], [`${HOME}/garden`]: [] };

function samplePlace(path: string): PlaceOutcome {
	const zone = resolvePlaceZone(path, SAMPLE.places, SAMPLE.defaultZone, { home: HOME, realpath: (p) => p }, () => ({ ok: true, urls: REMOTES[path] ?? [] }));
	return zone.ok ? { ok: true, path, zone: zone.zone, ...(zone.ruleIndex === undefined ? {} : { ruleIndex: zone.ruleIndex }) } : zone;
}

const work = samplePlace(`${HOME}/work/api`);
const garden = samplePlace(`${HOME}/garden`);
const sampleCheck = (place: PlaceOutcome) =>
	checkText({ ...context, place, account: acme, config: SAMPLE })
		.split("\n")
		.slice(1);

function sampleBlock(): string[] {
	const decision = decide({ place: garden, account: acme, config: { ok: true, config: SAMPLE } });
	if (decision.verdict !== "block") return [];
	const offers = [{ account: homelab, modelIds: ["home-model"] }];
	const dialog = blockDialog({ cause: decision.cause, place: garden, currentModelId: "work-model", accounts: SAMPLE.accounts, offers, context });
	return [...dialog.title.split("\n"), ...dialog.rows.map((row) => `  ${row.label}`)];
}

export const TOUR_STEPS: TourStep[] = [
	{
		title: "What pi-account-guard does",
		lines: [
			"Before a turn is sent, the guard checks the account pi is about to use against the directory it works in.",
			"An account is a provider id plus its auth source. You tag it with zones, such as work and personal.",
			"Place rules give each directory a zone, by its path or its git remotes; the rest falls to the default zone.",
			"When the account's zones include the place's zone, the turn goes. Otherwise it is blocked, and nothing is sent.",
		],
	},
	{
		title: "How a turn is checked",
		lines: [
			"acme (oauth) is tagged work. In a repository whose remote is under acme-corp:",
			...sampleCheck(work),
			"",
			"In ~/garden, which no rule matches:",
			...sampleCheck(garden),
		],
	},
	{
		title: "When a turn is blocked",
		lines: [
			...sampleBlock(),
			"",
			"Switch moves to an account of this zone and sends the same prompt; Cancel puts the prompt back.",
			"Allow once and Allow for session let the account through, in memory only. An untagged account asks for its zones first.",
		],
	},
	{
		title: "Where to look",
		lines: [
			"/guard",
			"    the place, the rule that decides it, the account and its Match",
			CHECK_USAGE,
			"    would a turn pass in that directory? Nothing is written",
			PLACE_ADD_USAGE,
			"    make a directory, or every repository with a matching remote, work or personal",
			TAG_USAGE,
			"    tag an account with its zones",
			"The footer shows the place zone and whether the account matches, for example: guard personal ✓",
		],
	},
];

/** Shown once, on the first session without a config file (stored next to it). */
export const FIRST_RUN_NOTICE =
	"pi-account-guard is on. Accounts start untagged: the first turn on an account asks which zones it belongs to. /guard shows this place and the account; /guard tour explains the rest.";
