import type { AccountKey } from "./account.ts";
import { accountZones, type ConfigError, type ConfigResult } from "./config.ts";

export type PlaceOutcome = { ok: true; path: string; zone: string; ruleIndex?: number } | { ok: false; reason: string };
export type ResolvedPlace = Extract<PlaceOutcome, { ok: true }>;

export interface DecideInput {
	place: PlaceOutcome;
	account: AccountKey;
	config: ConfigResult;
}

export type BlockCause =
	| { kind: "zone-mismatch"; account: AccountKey; accountZones: string[]; place: ResolvedPlace }
	| { kind: "unknown-account"; account: AccountKey; place: ResolvedPlace }
	| { kind: "config-invalid"; account: AccountKey; errors: ConfigError[] }
	| { kind: "place-undecidable"; account: AccountKey; reason: string }
	/** A failure of the guard's own check; `account` is the current model's, so both Overrides can still cover it (ADR 0001). */
	| { kind: "internal-error"; account: AccountKey; reason: string };

export type Decision = { verdict: "match" } | { verdict: "block"; cause: BlockCause };

/** A Match holds when the place zone is one of the account's zones; an untagged account is in the Unknown zone, which no place matches. Undecidable inputs Block (ADR 0001). */
export function decide({ place, account, config }: DecideInput): Decision {
	if (!config.ok) return { verdict: "block", cause: { kind: "config-invalid", account, errors: config.errors } };
	if (!place.ok) return { verdict: "block", cause: { kind: "place-undecidable", account, reason: place.reason } };
	const zones = accountZones(config.config.accounts, account);
	if (zones === undefined) return { verdict: "block", cause: { kind: "unknown-account", account, place } };
	if (zones.includes(place.zone)) return { verdict: "match" };
	return { verdict: "block", cause: { kind: "zone-mismatch", account, accountZones: zones, place } };
}
