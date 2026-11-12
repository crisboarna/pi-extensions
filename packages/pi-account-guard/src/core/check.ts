import { resolve } from "node:path";
import { type AccountKey, describeAccount } from "./account.ts";
import type { GuardConfig } from "./config.ts";
import { type Decision, decide, type PlaceOutcome } from "./decide.ts";
import { decideMembers, type MemberRef } from "./members.ts";
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
	/** What the router said about the models behind the checked virtual model (ADR 0006); absent when no router answered. */
	members?: CheckMembers;
}

/** The members a router listed, each with its account (`undefined` when pi does not list the model), or why it could not list them. */
export type CheckMembers = { status: "members"; members: Array<{ ref: MemberRef; account: AccountKey | undefined }> } | { status: "invalid"; reason: string };

const HEADING_WIDTH = 9;

/** The text of `/guard check`: which rule decides a directory, its zone, and whether the account would pass there. It describes; it never writes. */
export function checkText({ place, account, config, home, members }: CheckInput): string {
	const result = { ok: true as const, config };
	const rows: Array<[string, string]> = [
		["Place", place.ok ? placeSummary({ place, config: result, cwd: place.path, home }) : `unknown (${place.reason})`],
		["Account", accountSummary({ account, place, config: result })],
		...(account && members ? [["Members", membersValue(members, place, result)] as [string, string]] : []),
		["Verdict", account ? verdict(decisionOf(place, account, config, members)) : "no account to check: select a model, or name one"],
	];
	return [
		"guard check (nothing is written)",
		...rows.flatMap(([heading, value]) => {
			const [first, ...more] = value.split("\n");
			return [` ${heading.padEnd(HEADING_WIDTH)} ${first}`, ...more.map((line) => ` ${" ".repeat(HEADING_WIDTH)} ${line}`)];
		}),
	].join("\n");
}

function membersValue(members: CheckMembers, place: PlaceOutcome, config: { ok: true; config: GuardConfig }): string {
	if (members.status === "invalid") return `unknown (${members.reason})`;
	return members.members
		.map(({ ref, account }) => `${ref.provider}/${ref.id}: ${account ? accountSummary({ account, place, config }) : "not listed by pi  ! cannot decide"}`)
		.join("\n");
}

/** The turn check's decision without Overrides: on the account, or on every member a router listed (ADR 0006). */
function decisionOf(place: PlaceOutcome, account: AccountKey, config: GuardConfig, members: CheckMembers | undefined): Decision {
	const result = { ok: true as const, config };
	if (!members) return decide({ place, account, config: result });
	if (members.status === "invalid") return { verdict: "block", cause: { kind: "internal-error", account, reason: members.reason } };
	const accounts = new Map(members.members.map(({ ref, account: of }) => [`${ref.provider}/${ref.id}`, of]));
	return decideMembers({
		members: members.members.map(({ ref }) => ref),
		place,
		config: result,
		virtual: account,
		accountOf: (ref) => accounts.get(`${ref.provider}/${ref.id}`),
		passes: () => false,
	});
}

function verdict(decision: Decision): string {
	if (decision.verdict === "match") return "a turn here would go";
	const { cause } = decision;
	switch (cause.kind) {
		case "zone-mismatch":
			return `a turn here would be blocked: ${describeAccount(cause.account)} is zone ${cause.accountZones.join(", ")}, this place is ${cause.place.zone}`;
		case "unknown-account":
			return `the tag prompt would ask for the zones of ${describeAccount(cause.account)} first`;
		case "place-undecidable":
			return `a turn here would be blocked: cannot decide this place's zone (${cause.reason})`;
		case "internal-error":
			return `a turn here would be blocked: ${cause.reason}`;
		default:
			return "a turn here would be blocked";
	}
}
