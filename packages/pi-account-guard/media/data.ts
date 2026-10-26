// Generates media/src/data.json (and data.js for the pages): what the README
// animations and the cover show, produced by the guard's real core on
// scripted inputs, so every account, rule, zone, verdict and line of text on
// screen is one pi-account-guard would produce. The accounts, places and
// config are the terminal scenes' demo ones.
//
//   node media/data.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccountKey, accountKey, describeAccount } from "../src/core/account.ts";
import { blockDialog } from "../src/core/block-dialog.ts";
import { type GuardConfig, parseConfig } from "../src/core/config.ts";
import { decide, type PlaceOutcome } from "../src/core/decide.ts";
import { footerText } from "../src/core/footer.ts";
import { failoverBlockedNotice, midTurnDialog } from "../src/core/mid-turn.ts";
import { NO_OVERRIDES } from "../src/core/overrides.ts";
import { displayPath } from "../src/core/paths.ts";
import { resolvePlaceZone } from "../src/core/place.ts";
import { addPlaceRule, movePlaceRule } from "../src/core/place-edit.ts";
import { normalizeRemoteUrl } from "../src/core/remote.ts";
import { ruleText } from "../src/core/status.ts";
import { ACCOUNTS, CONFIG } from "./terminal/setup.ts";

const HOME = "/home/dev";
const context = { home: HOME, configPath: `${HOME}/.pi/agent/account-guard.json` };
const paths = { home: HOME, realpath: (path: string) => path };

/** The demo directories and the git remotes of each. */
const PLACES: Record<string, string[]> = {
	"~/work/acme-api": ["git@github.com:acme-corp/acme-api.git"],
	"~/work/notes": [],
	"~/work/side-project": ["https://github.com/dev/side-project.git"],
	"~/personal/garden-planner": ["https://github.com/dev/garden-planner.git"],
};

const config = (): GuardConfig => {
	const result = parseConfig(JSON.stringify(CONFIG));
	if (!result.ok) throw new Error(`demo config is invalid: ${JSON.stringify(result.errors)}`);
	return result.config;
};

/** The Account pi reports for a demo provider: the environment key it authenticates with. */
function account(provider: string): AccountKey {
	const label = ACCOUNTS[provider]?.key;
	if (label === undefined) throw new Error(`no demo account ${provider}`);
	return accountKey({ provider, usingOAuth: false, status: { configured: true, source: "environment", label } });
}

function place(where: string, guard: GuardConfig): PlaceOutcome {
	const path = where.replace(/^~/, HOME);
	const zone = resolvePlaceZone(path, guard.places, guard.defaultZone, paths, () => ({ ok: true, urls: PLACES[where] ?? [] }));
	return zone.ok ? { ok: true, path, zone: zone.zone, ...(zone.ruleIndex === undefined ? {} : { ruleIndex: zone.ruleIndex }) } : zone;
}

const offers = Object.entries(ACCOUNTS).map(([provider, { models }]) => ({ account: account(provider), modelIds: models }));
const rules = (guard: GuardConfig) => guard.places.map((rule) => ({ text: ruleText(rule), zone: rule.zone }));

/** One turn checked: the account's zones against the place's zone, with the footer and, on a Block, the select. */
function check(provider: string, where: string) {
	const guard = config();
	const key = account(provider);
	const outcome = place(where, guard);
	const decision = decide({ place: outcome, account: key, config: { ok: true, config: guard } });
	const tag = guard.accounts.find((entry) => entry.provider === key.provider && entry.source === key.source);
	if (!outcome.ok) throw new Error(`undecidable place ${where}`);
	const dialog =
		decision.verdict === "block"
			? blockDialog({
					cause: decision.cause,
					place: outcome,
					currentModelId: ACCOUNTS[provider]?.models[0] ?? "",
					accounts: guard.accounts,
					offers,
					context,
				})
			: undefined;
	return {
		account: { name: describeAccount(key), source: key.source, zones: tag?.zones ?? [] },
		place: { path: displayPath(outcome.path, HOME), remotes: (PLACES[where] ?? []).map(normalizeRemoteUrl), zone: outcome.zone, rule: outcome.ruleIndex },
		verdict: decision.verdict,
		footer: footerText({ place: outcome, account: key, config: { ok: true, config: guard }, usingLastValid: false, overrides: NO_OVERRIDES }),
		...(dialog ? { block: { title: dialog.title.split("\n"), rows: dialog.rows.map((row) => row.label) } } : {}),
	};
}

/** Place rules: four directories against the rules in file order; a new rule added last never fires until it is moved to the top. */
function placeRules() {
	const base = config();
	const added = addPlaceRule(base, { path: "~/work/side-project", zone: "personal" }, base.places.length);
	const moved = movePlaceRule(added, added.places.length - 1, 0);
	const resolveAll = (guard: GuardConfig) =>
		Object.keys(PLACES).map((where) => {
			const outcome = place(where, guard);
			if (!outcome.ok) throw new Error(`undecidable place ${where}`);
			return { where, remotes: (PLACES[where] ?? []).map(normalizeRemoteUrl), zone: outcome.zone, rule: outcome.ruleIndex };
		});
	return {
		defaultZone: base.defaultZone,
		before: { rules: rules(added), places: resolveAll(added) },
		after: { rules: rules(moved), places: resolveAll(moved) },
	};
}

/** A rotator moves a running turn in a personal place from homelab to the work account; the guard aborts it and offers homelab first. */
function rotation() {
	const guard = config();
	const where = "~/personal/garden-planner";
	const outcome = place(where, guard);
	const steps = ["homelab", "acme"].map((provider) => ({ provider, ...check(provider, where) }));
	const moved = decide({ place: outcome, account: account("acme"), config: { ok: true, config: guard } });
	if (moved.verdict !== "block") throw new Error("expected the rotation to be blocked");
	const dialog = midTurnDialog(
		{ cause: moved.cause, place: outcome, currentModelId: "home-model", accounts: guard.accounts, offers, context },
		account("homelab"),
	);
	return {
		steps,
		notice: failoverBlockedNotice(moved.cause, outcome, context),
		select: { title: dialog.title.split("\n"), rows: dialog.rows.map((row) => row.label) },
	};
}

const turns = [check("homelab", "~/personal/garden-planner"), check("acme", "~/personal/garden-planner"), check("acme", "~/work/acme-api")];
const data = {
	turn: { rules: rules(config()), defaultZone: config().defaultZone, turns },
	places: placeRules(),
	rotation: rotation(),
	cover: `${turns[0]?.footer}  ${turns[0]?.account.name.split(" ")[0]} in ${turns[0]?.place.path}`,
};
const json = JSON.stringify(data, null, "\t");
writeFileSync(join(import.meta.dirname, "src", "data.json"), `${json}\n`);
// Pages opened from file:// cannot fetch JSON, so they load the same data as a one-line script; data.json is the readable copy.
writeFileSync(join(import.meta.dirname, "src", "data.js"), `window.MEDIA = ${JSON.stringify(data)};\n`);
console.log(`media data: ${data.cover}`);
