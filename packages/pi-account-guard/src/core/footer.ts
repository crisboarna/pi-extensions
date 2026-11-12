import { type AccountKey, sameAccount } from "./account.ts";
import { accountZones, type ConfigResult } from "./config.ts";
import { type Decision, decide, type PlaceOutcome } from "./decide.ts";
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
	/** The decision the checks make when it is not the account's own: the member check behind a virtual model (ADR 0006). */
	decision?: Decision | undefined;
}

/** The text of the `guard` footer item (DESIGN.md section 12): the place zone and the Match state, never the account of a Match. */
export function footerText({ place, account, config, usingLastValid, overrides, decision: given }: FooterInput): string {
	const decision = given ?? (account && decide({ place, account, config }));
	// The account the footer is about: the current model's, or the member behind a virtual model that blocks (ADR 0006).
	const shown = decision?.verdict === "block" ? decision.cause.account : account;
	// A session Override shows only while it covers that account; allow-once ends with its turn and is not shown.
	const sessionFooter = sessionOverrideFooter(overrides);
	if (shown && decision?.verdict === "block" && sessionFooter && overrides.session && sameAccount(overrides.session.account, shown)) return sessionFooter;
	if (!config.ok) return "guard ! config invalid, turns blocked";
	if (usingLastValid) return "guard ! config invalid (last valid copy in use)";
	if (!place.ok) return `guard ! zone unknown (${place.reason})`;
	if (!account || !shown) return `guard ${place.zone} ? no model`;
	if (decision?.verdict === "match") return `guard ${place.zone} ✓`;
	if (decision?.verdict === "block" && decision.cause.kind === "internal-error") return "guard ! check failed, turns blocked";
	const zones = accountZones(config.config.accounts, shown);
	if (zones) return `guard ${place.zone} ✗ ${shown.provider} is ${zones.join(", ")}`;
	// A member behind a virtual model is named; the current model's own account needs no name.
	return shown === account ? `guard ${place.zone} ? untagged` : `guard ${place.zone} ? ${shown.provider} untagged`;
}
