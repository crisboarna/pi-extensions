import { describeAccount, sameAccount, type AccountKey } from "./account.ts";
import { formatConfigErrors, type AccountTag } from "./config.ts";
import type { BlockCause, PlaceOutcome } from "./decide.ts";
import { zonePhrase, type MessageContext } from "./messages.ts";
import { displayPath } from "./place.ts";

/** A Block with an account to act on; an internal error names none, so it has no dialog. */
export type DialogCause = Exclude<BlockCause, { kind: "internal-error" }>;

/** The models a configured account offers now, in registry order. */
export interface ModelOffer {
	account: AccountKey;
	modelIds: string[];
}

export type DialogRow =
	| { kind: "switch"; label: string; account: AccountKey; modelId: string; zones: string[]; /** Set when the current model id is not offered by the target account. */ notOffered?: string }
	| { kind: "allow-once"; label: string }
	| { kind: "allow-session"; label: string }
	| { kind: "cancel"; label: string };

export interface BlockDialog {
	title: string;
	rows: DialogRow[];
}

export interface BlockDialogInput {
	cause: DialogCause;
	place: PlaceOutcome;
	/** Id of the model the Block happened on. */
	currentModelId: string;
	accounts: AccountTag[];
	offers: ModelOffer[];
	context: MessageContext;
}

/** The title and flat list of rows of a Block (DESIGN.md section 9.1): Switch rows in config order, Allow once, Allow for session, Cancel. */
export function blockDialog({ cause, place, currentModelId, accounts, offers, context }: BlockDialogInput): BlockDialog {
	const account = describeAccount(cause.account);
	return {
		title: `${blockTitle(cause, context)}\n${placeLine(place, context)}`,
		rows: [
			...(place.ok ? switchRows(place.zone, currentModelId, accounts, offers) : []),
			{ kind: "allow-once", label: `Allow once: this turn to ${account}` },
			{ kind: "allow-session", label: `Allow for session: ${account}` },
			{ kind: "cancel", label: "Cancel" },
		],
	};
}

function blockTitle(cause: DialogCause, context: MessageContext): string {
	const account = describeAccount(cause.account);
	switch (cause.kind) {
		case "zone-mismatch":
			return `BLOCKED  ${account} is ${zonePhrase(cause.accountZones)}`;
		case "unknown-account":
			return `BLOCKED  ${account} has no zone tag`;
		case "config-invalid": {
			const file = context.configPath.slice(context.configPath.lastIndexOf("/") + 1);
			return [`BLOCKED  cannot read ${file}`, ...formatConfigErrors(cause.errors, file)].join("\n");
		}
		case "place-undecidable":
			return `BLOCKED  cannot decide the zone of this place (${cause.reason})`;
	}
}

function placeLine(place: PlaceOutcome, context: MessageContext): string {
	return place.ok ? `Place ${displayPath(place.path, context.home)} -> zone ${place.zone}` : "Place zone unknown";
}

/** Accounts tagged with the place zone whose auth is configured now (they have an offer), in config order. */
function switchRows(placeZone: string, currentModelId: string, accounts: AccountTag[], offers: ModelOffer[]): DialogRow[] {
	const rows: DialogRow[] = [];
	for (const tag of accounts) {
		if (!tag.zones.includes(placeZone)) continue;
		const offer = offers.find((candidate) => sameAccount(candidate.account, tag));
		const first = offer?.modelIds[0];
		if (!offer || first === undefined) continue;
		const offered = offer.modelIds.includes(currentModelId);
		const modelId = offered ? currentModelId : first;
		const key = { provider: tag.provider, source: tag.source };
		rows.push({
			kind: "switch",
			label: `Switch to ${describeAccount(key)} -> ${modelId}  [${tag.zones.join(", ")}]`,
			account: key,
			modelId,
			zones: tag.zones,
			...(offered ? {} : { notOffered: currentModelId }),
		});
	}
	return rows;
}

/** The notice after a Switch; it says when the current model id was not offered by the target account. */
export function switchNotice(row: Extract<DialogRow, { kind: "switch" }>): string {
	const fallback = row.notOffered === undefined ? "" : ` using model ${row.modelId} (${row.notOffered} not offered)`;
	return `Switched to ${describeAccount(row.account)}${fallback}, sending.`;
}

/** The yes/no confirm of Allow once; it names the account and the place zone (DESIGN.md section 10). */
export function allowOnceConfirm(cause: DialogCause, place: PlaceOutcome, context: MessageContext): { title: string; message: string } {
	const account = describeAccount(cause.account);
	const accountZones = cause.kind === "zone-mismatch" ? `, ${zonePhrase(cause.accountZones)}` : cause.kind === "unknown-account" ? ", no zone tag" : "";
	const where = place.ok ? `a ${place.zone} place (${displayPath(place.path, context.home)})` : "a place whose zone is unknown";
	return { title: "Allow once?", message: `Send ONE turn to ${account}${accountZones}, from ${where}.` };
}

/** Data of a `guard.block`, `guard.allow_once` or `guard.allow_session` session log entry. */
export function logData(cause: DialogCause, place: PlaceOutcome): { account: AccountKey; cause: string; place: { path?: string; zone: string } } {
	return {
		account: { provider: cause.account.provider, source: cause.account.source },
		cause: cause.kind,
		place: place.ok ? { path: place.path, zone: place.zone } : { zone: "unknown" },
	};
}
