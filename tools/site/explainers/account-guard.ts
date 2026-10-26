// pi-account-guard's config tester for the site: the guard's own core decides
// which rule gives a directory its zone and whether an account would pass
// there, exactly as /guard check prints it. Pure: no file, no git, no pi.
import { checkPath, checkText } from "../../../packages/pi-account-guard/src/core/check.ts";
import { formatConfigErrors, parseConfig } from "../../../packages/pi-account-guard/src/core/config.ts";
import { decide, type PlaceOutcome } from "../../../packages/pi-account-guard/src/core/decide.ts";
import { resolvePlaceZone } from "../../../packages/pi-account-guard/src/core/place.ts";

export interface GuardQuestion {
	/** The text of account-guard.json; empty means no file (the defaults). */
	configText: string;
	/** The directory: absolute, or starting with `~`. */
	directory: string;
	/** Its git remote URLs, as `git remote -v` lists them. */
	remotes: string[];
	provider: string;
	source: string;
	/** The home directory `~` stands for. */
	home: string;
}

export type GuardAnswer =
	| { ok: true; text: string; zone: string | undefined; rule: number | undefined; verdict: "match" | "block" }
	| { ok: false; errors: string[] };

export function explainGuard({ configText, directory, remotes, provider, source, home }: GuardQuestion): GuardAnswer {
	const parsed = parseConfig(configText.trim() === "" ? undefined : configText);
	if (!parsed.ok) return { ok: false, errors: formatConfigErrors(parsed.errors, "account-guard.json") };
	const { config } = parsed;
	const path = checkPath(directory, home, home);
	const resolved = resolvePlaceZone(path, config.places, config.defaultZone, { home, realpath: (real) => real }, () => ({ ok: true, urls: remotes }));
	const place: PlaceOutcome = resolved.ok
		? { ok: true, path, zone: resolved.zone, ...(resolved.ruleIndex === undefined ? {} : { ruleIndex: resolved.ruleIndex }) }
		: resolved;
	const account = { provider, source };
	const text = checkText({ home, configPath: `${home}/.pi/agent/account-guard.json`, place, account, config });
	const verdict = decide({ place, account, config: parsed }).verdict;
	return { ok: true, text, zone: place.ok ? place.zone : undefined, rule: place.ok ? place.ruleIndex : undefined, verdict };
}
