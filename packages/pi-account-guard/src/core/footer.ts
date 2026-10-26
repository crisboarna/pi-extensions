import { type AccountKey, sameAccount } from "./account.ts";
import { accountZones, type ConfigResult } from "./config.ts";
import { decide, type PlaceOutcome } from "./decide.ts";
import { type Overrides, sessionOverrideFooter } from "./overrides.ts";

export interface FooterInput {
	place: PlaceOutcome;
	/** The Account of the current model; `undefined` when no model is selected. */
	account: AccountKey | undefined;
	/** What the checks decide with: the live file, or the last valid copy. */
	config: ConfigResult;
	/** The file is malformed and `config` is the last valid copy of this session. */
	usingLastValid: boolean;
	overrides: Overrides;
}

/** The text of the `guard` footer item (DESIGN.md section 12): the place zone and the Match state, never the account of a Match. */
export function footerText({ place, account, config, usingLastValid, overrides }: FooterInput): string {
	const decision = account && decide({ place, account, config });
	// A session Override shows only while it covers the current account; allow-once ends with its turn and is not shown.
	const sessionFooter = sessionOverrideFooter(overrides);
	if (account && decision?.verdict === "block" && sessionFooter && overrides.session && sameAccount(overrides.session.account, account)) return sessionFooter;
	if (!config.ok) return "guard ! config invalid, turns blocked";
	if (usingLastValid) return "guard ! config invalid (last valid copy in use)";
	if (!place.ok) return `guard ! zone unknown (${place.reason})`;
	if (!account) return `guard ${place.zone} ? no model`;
	if (decision?.verdict === "match") return `guard ${place.zone} ✓`;
	const zones = accountZones(config.config.accounts, account);
	return zones ? `guard ${place.zone} ✗ ${account.provider} is ${zones.join(", ")}` : `guard ${place.zone} ? untagged`;
}
