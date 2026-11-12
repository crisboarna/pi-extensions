import type { AccountKey } from "./account.ts";
import type { ConfigResult } from "./config.ts";
import { type Decision, decide, type PlaceOutcome } from "./decide.ts";

/**
 * The event-bus channel on which a router lists every physical model a virtual model can route to (ADR 0006). The guard emits
 * `{ provider, id, respond }` for the selected model; the router that owns it calls `respond` at once with `{ members }` or `{ error }`.
 */
export const MEMBERS_CHANNEL = "switchboard:members:v1";

/** One physical model behind a virtual model. */
export interface MemberRef {
	provider: string;
	id: string;
}

/** `none`: no router answered, so the model is checked as its own account (ADR 0004). `invalid` Blocks (ADR 0001). */
export type MembersAnswer = { status: "none" } | { status: "members"; members: MemberRef[] } | { status: "invalid"; reason: string };

/** More members than any real router config holds: a longer list is treated as broken. */
const MAX_MEMBERS = 1000;
const MAX_REASON = 200;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
/** The router's error text is shown in the Block; terminal control characters are replaced first. */
const printable = (text: string): string =>
	[...text.slice(0, MAX_REASON)]
		.map((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
		})
		.join("");

/** Reads what the router passed to `respond`. Any shape but a non-empty list of `{ provider, id }` is invalid. */
export function parseMembersAnswer(value: unknown): MembersAnswer {
	if (isObject(value) && typeof value.error === "string")
		return { status: "invalid", reason: `switchboard could not list its members: ${printable(value.error)}` };
	if (!isObject(value) || !Array.isArray(value.members)) return { status: "invalid", reason: "switchboard answered without a member list" };
	const list: unknown[] = value.members;
	if (list.length === 0 || list.length > MAX_MEMBERS) return { status: "invalid", reason: `switchboard listed ${list.length} members` };
	const members: MemberRef[] = [];
	for (const entry of list) {
		if (!isObject(entry) || !isName(entry.provider) || !isName(entry.id))
			return { status: "invalid", reason: "switchboard listed a member that is not a model" };
		members.push({ provider: entry.provider, id: entry.id });
	}
	return { status: "members", members };
}

export interface DecideMembersInput {
	members: MemberRef[];
	place: PlaceOutcome;
	config: ConfigResult;
	/** The virtual model's own account: a member that cannot be resolved Blocks on it, so its Overrides still apply (ADR 0001). */
	virtual: AccountKey;
	/** The account of a member, `undefined` when pi does not list the model. */
	accountOf(member: MemberRef): AccountKey | undefined;
	/** Whether an Override, or the process Override for an Unknown account, lets this Block through. */
	passes(decision: Extract<Decision, { verdict: "block" }>): boolean;
}

/**
 * The decision over every member: a Match only when each member's account matches the place. A Block nothing lets through wins;
 * otherwise the first Block an Override covers is returned, so the caller applies and logs that Override.
 */
export function decideMembers({ members, place, config, virtual, accountOf, passes }: DecideMembersInput): Decision {
	let covered: Decision | undefined;
	for (const member of members) {
		const account = accountOf(member);
		if (!account)
			return {
				verdict: "block",
				cause: { kind: "internal-error", account: virtual, reason: `switchboard routes to ${member.provider}/${member.id}, which pi does not list` },
			};
		const decision = decide({ place, account, config });
		if (decision.verdict === "match") continue;
		if (!passes(decision)) return decision;
		covered ??= decision;
	}
	return covered ?? { verdict: "match" };
}
