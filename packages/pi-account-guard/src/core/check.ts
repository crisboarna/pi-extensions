import { resolve } from "node:path";
import { type AccountKey, describeAccount } from "./account.ts";
import type { GuardConfig } from "./config.ts";
import { decide, type PlaceOutcome } from "./decide.ts";
import type { MessageContext } from "./messages.ts";
import { expandTilde } from "./paths.ts";
import { accountSummary, placeSummary } from "./status.ts";

/** The absolute path a `/guard check` argument names: `here` is the session directory; `~` and relative paths are expanded. */
export function checkPath(argument: string, sessionDirectory: string, home: string): string {
	return resolve(sessionDirectory, argument === "here" ? "." : expandTilde(argument, home));
}

export interface CheckInput extends MessageContext {
	place: PlaceOutcome;
	/** The account to check: the named one, or the current model's; `undefined` when there is neither. */
	account: AccountKey | undefined;
	config: GuardConfig;
}

const HEADING_WIDTH = 9;

/** The text of `/guard check`: which rule decides a directory, its zone, and whether the account would pass there. It describes; it never writes. */
export function checkText({ place, account, config, home }: CheckInput): string {
	const result = { ok: true as const, config };
	const rows: Array<[string, string]> = [
		["Place", place.ok ? placeSummary({ place, config: result, cwd: place.path, home }) : `unknown (${place.reason})`],
		["Account", accountSummary({ account, place, config: result })],
		["Verdict", verdict(place, account, config)],
	];
	return ["guard check (nothing is written)", ...rows.map(([heading, value]) => ` ${heading.padEnd(HEADING_WIDTH)} ${value}`)].join("\n");
}

function verdict(place: PlaceOutcome, account: AccountKey | undefined, config: GuardConfig): string {
	if (!account) return "no account to check: select a model, or name one";
	const decision = decide({ place, account, config: { ok: true, config } });
	if (decision.verdict === "match") return "a turn here would go";
	const { cause } = decision;
	switch (cause.kind) {
		case "zone-mismatch":
			return `a turn here would be blocked: ${describeAccount(account)} is zone ${cause.accountZones.join(", ")}, this place is ${cause.place.zone}`;
		case "unknown-account":
			return `the tag prompt would ask for the zones of ${describeAccount(account)} first`;
		case "place-undecidable":
			return `a turn here would be blocked: cannot decide this place's zone (${cause.reason})`;
		default:
			return "a turn here would be blocked";
	}
}
