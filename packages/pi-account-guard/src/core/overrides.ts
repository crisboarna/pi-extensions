import { type AccountKey, sameAccount } from "./account.ts";
import type { Decision, PlaceOutcome } from "./decide.ts";

/** An Override covers one account; allow-once also covers one place (DESIGN.md section 10). Neither is persisted. */
export interface Overrides {
	/** One turn, until `agent_end`. */
	once?: { account: AccountKey; placeId: string };
	/** The rest of the session. `zone` is the place zone at the time it was granted, for the footer. */
	session?: { account: AccountKey; zone: string };
}

export const NO_OVERRIDES: Overrides = {};

export type OverrideKind = "allow-once" | "allow-session";

/** What a Decision becomes once the Overrides are applied. */
export type Verdict = { verdict: "match" } | { verdict: "override"; by: OverrideKind } | Extract<Decision, { verdict: "block" }>;

/** Identifies the place an allow-once is bound to: the real path, or one shared id for an undecidable place. */
export function placeId(place: PlaceOutcome): string {
	return place.ok ? place.path : "undecidable";
}

/** The zone shown for a place in the footer and in log entries. */
export function placeZoneLabel(place: PlaceOutcome): string {
	return place.ok ? place.zone : "unknown";
}

export function grantOnce(overrides: Overrides, account: AccountKey, place: PlaceOutcome): Overrides {
	return { ...overrides, once: { account, placeId: placeId(place) } };
}

/** A session Override binds to one account, so a new grant replaces the previous one. */
export function grantSession(overrides: Overrides, account: AccountKey, place: PlaceOutcome): Overrides {
	return { ...overrides, session: { account, zone: placeZoneLabel(place) } };
}

export function releaseOnce({ once: _once, ...rest }: Overrides): Overrides {
	return rest;
}

/** A Block passes when an Override covers its account (and, for allow-once, its place). Every cause names an account and can be overridden, so a broken config or a bug in the guard never locks the user out (ADR 0001). */
export function applyOverrides(decision: Decision, place: PlaceOutcome, overrides: Overrides): Verdict {
	if (decision.verdict === "match") return decision;
	const { account } = decision.cause;
	if (overrides.once && sameAccount(overrides.once.account, account) && overrides.once.placeId === placeId(place))
		return { verdict: "override", by: "allow-once" };
	if (overrides.session && sameAccount(overrides.session.account, account)) return { verdict: "override", by: "allow-session" };
	return decision;
}

/** The footer text while a session Override is active; `undefined` when none is (DESIGN.md section 12). */
export function sessionOverrideFooter(overrides: Overrides): string | undefined {
	return overrides.session ? `guard OVERRIDE ${overrides.session.account.provider} in ${overrides.session.zone}` : undefined;
}
