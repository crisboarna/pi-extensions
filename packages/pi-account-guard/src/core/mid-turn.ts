import { type AccountKey, describeAccount, sameAccount } from "./account.ts";
import { type BlockDialog, type BlockDialogInput, blockDialog, type DialogRow, switchedTo } from "./block-dialog.ts";
import type { BlockCause, PlaceOutcome } from "./decide.ts";
import { type MessageContext, placeWhere } from "./messages.ts";
import { displayPath } from "./paths.ts";

/** The model a session ran on before a model change, as the Block select offers it back. */
export interface PreviousModel {
	account: AccountKey;
	modelId: string;
}

/** The notice after the guard aborted a turn because the model changed mid-turn (DESIGN.md section 9.2); it says a failover was blocked. */
export function failoverBlockedNotice(cause: BlockCause, place: PlaceOutcome, context: MessageContext): string {
	return `guard: failover blocked, model changed to ${describeAccount(cause.account)} ${accountState(cause, context)} during a turn in ${placeWhere(place, context)}. Turn aborted.`;
}

/** The notice after the guard aborted a run in `before_agent_start`, before any request was sent (DESIGN.md section 8). */
export function blockedBeforeSendNotice(cause: BlockCause, place: PlaceOutcome, context: MessageContext): string {
	return `guard: blocked before sending, the model is ${describeAccount(cause.account)} ${accountState(cause, context)} in ${placeWhere(place, context)}. Run aborted, no request was sent.`;
}

/**
 * The Block select once the aborted turn is idle (DESIGN.md section 9.2): no Allow once, because there is no prompt to resend,
 * and the previous account first when it is a Switch row. Pass the previous model id as `currentModelId` so a Switch keeps the model the session was on.
 */
export function midTurnDialog(input: BlockDialogInput, previousAccount: AccountKey | undefined): BlockDialog {
	const dialog = blockDialog(input);
	const rows = dialog.rows.filter((row) => row.kind !== "allow-once");
	const previousIndex = previousAccount ? rows.findIndex((row) => row.kind === "switch" && sameAccount(row.account, previousAccount)) : -1;
	if (previousIndex > 0) rows.unshift(...rows.splice(previousIndex, 1));
	return { title: dialog.title, rows };
}

/** The notice after a Switch from the mid-turn select; the aborted turn is not resumed. */
export function midTurnSwitchNotice(row: Extract<DialogRow, { kind: "switch" }>): string {
	return `Switched to ${switchedTo(row)}. The aborted turn is not resumed.`;
}

/** The notice after Allow for session from the mid-turn select. */
export function midTurnSessionNotice(cause: BlockCause): string {
	return `Allow for session: ${describeAccount(cause.account)}. The aborted turn is not resumed.`;
}

function accountState(cause: BlockCause, context: MessageContext): string {
	switch (cause.kind) {
		case "zone-mismatch":
			return `[${cause.accountZones.join(", ")}]`;
		case "unknown-account":
			return "[no zone tag]";
		case "config-invalid":
			return `[cannot read ${displayPath(context.configPath, context.home)}]`;
		case "place-undecidable":
			return `[cannot decide the zone of the place: ${cause.reason}]`;
		case "internal-error":
			return `[the guard failed: ${cause.reason}]`;
	}
}
