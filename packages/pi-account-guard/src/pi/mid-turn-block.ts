import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logData } from "../core/block-dialog.ts";
import type { GuardConfig } from "../core/config.ts";
import type { BlockCause, PlaceOutcome } from "../core/decide.ts";
import type { MessageContext } from "../core/messages.ts";
import { midTurnDialog, midTurnSessionNotice, midTurnSwitchNotice, type PreviousModel } from "../core/mid-turn.ts";
import { grantSession } from "../core/overrides.ts";
import type { AccountOfModel } from "./account-of.ts";
import { type OverrideStore, offersOf, switchTo } from "./interactive-block.ts";

export interface MidTurnBlock {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	accountOfModel: AccountOfModel;
	cause: BlockCause;
	place: PlaceOutcome;
	/** The tags of the live config; `undefined` when the config is invalid. */
	config: GuardConfig | undefined;
	/** The model the session ran on before the change, when pi told. */
	previous: PreviousModel | undefined;
	overrides: OverrideStore;
	messages: MessageContext;
}

/**
 * Opens the Block select once the aborted turn is idle (DESIGN.md section 9.2): previous account first, no Allow once.
 * Switch and Allow for session act at once; Cancel leaves the model as it is. The aborted turn is never resumed.
 */
export async function runMidTurnBlock(block: MidTurnBlock): Promise<void> {
	const { pi, ctx, cause, place } = block;
	const dialog = midTurnDialog(
		{
			cause,
			place,
			currentModelId: block.previous?.modelId ?? ctx.model?.id ?? "",
			accounts: block.config?.accounts ?? [],
			offers: offersOf(ctx, block.accountOfModel),
			context: block.messages,
		},
		block.previous?.account,
	);
	const answer = await ctx.ui.select(
		dialog.title,
		dialog.rows.map((row) => row.label),
	);
	const row = dialog.rows.find((candidate) => candidate.label === answer);
	switch (row?.kind) {
		case "switch":
			await switchTo(row, block, midTurnSwitchNotice);
			return;
		case "allow-session":
			block.overrides.replace(grantSession(block.overrides.current(), cause.account, place), ctx);
			pi.appendEntry("guard.allow_session", logData(cause, place));
			ctx.ui.notify(midTurnSessionNotice(cause), "info");
			return;
		default:
			return;
	}
}
