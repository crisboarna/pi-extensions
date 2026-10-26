import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sameAccount } from "../core/account.ts";
import { allowOnceConfirm, blockDialog, logData, switchNotice, type DialogCause, type DialogRow, type ModelOffer } from "../core/block-dialog.ts";
import type { GuardConfig } from "../core/config.ts";
import type { PlaceOutcome } from "../core/decide.ts";
import type { MessageContext } from "../core/messages.ts";
import { grantOnce, grantSession, sessionOverrideFooter, type Overrides } from "../core/overrides.ts";
import { accountOfModel } from "./account-of.ts";

/** Holds the Overrides of one session; never persisted. */
export interface OverrideStore {
	current(): Overrides;
	replace(next: Overrides): void;
}

export interface InteractiveBlock {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	cause: DialogCause;
	place: PlaceOutcome;
	/** The tags of the live config; `undefined` when the config is invalid. */
	config: GuardConfig | undefined;
	/** The prompt the user typed, put back in the editor on Cancel. */
	text: string;
	overrides: OverrideStore;
	messages: MessageContext;
}

/** The `input` result: `continue` sends the same prompt, `handled` stops it. */
export type InputOutcome = { action: "continue" } | { action: "handled" };

/** Shows the Block select (and the Allow once confirm) through `ctx.ui`, which RPC serves as UI requests; no answer counts as Cancel. */
export async function runInteractiveBlock(block: InteractiveBlock): Promise<InputOutcome> {
	const { pi, ctx, cause, place } = block;
	const model = ctx.model;
	const dialog = blockDialog({
		cause,
		place,
		currentModelId: model?.id ?? "",
		accounts: block.config?.accounts ?? [],
		offers: offersOf(ctx),
		context: block.messages,
	});
	const answer = await ctx.ui.select(dialog.title, dialog.rows.map((row) => row.label));
	const row = dialog.rows.find((candidate) => candidate.label === answer);
	switch (row?.kind) {
		case "switch":
			return (await switchTo(row, block)) ? { action: "continue" } : cancel(block);
		case "allow-once": {
			const { title, message } = allowOnceConfirm(cause, place, block.messages);
			if (!(await ctx.ui.confirm(title, message))) return cancel(block);
			block.overrides.replace(grantOnce(block.overrides.current(), cause.account, place));
			pi.appendEntry("guard.allow_once", logData(cause, place));
			return { action: "continue" };
		}
		case "allow-session":
			block.overrides.replace(grantSession(block.overrides.current(), cause.account, place));
			showOverrideFooter(ctx, block.overrides.current());
			pi.appendEntry("guard.allow_session", logData(cause, place));
			return { action: "continue" };
		default:
			return cancel(block);
	}
}

/** Updates the footer item for the session Override; `undefined` text clears it. */
export function showOverrideFooter(ctx: ExtensionContext, overrides: Overrides): void {
	ctx.ui.setStatus("guard", sessionOverrideFooter(overrides));
}

function cancel({ ctx, text }: InteractiveBlock): InputOutcome {
	ctx.ui.setEditorText(text);
	return { action: "handled" };
}

/** Switches the model to the row's account; the notice defaults to the one of a Block at turn start. */
export async function switchTo(
	row: Extract<DialogRow, { kind: "switch" }>,
	{ pi, ctx }: Pick<InteractiveBlock, "pi" | "ctx">,
	noticeOf: (row: Extract<DialogRow, { kind: "switch" }>) => string = switchNotice,
): Promise<boolean> {
	const target = ctx.modelRegistry.find(row.account.provider, row.modelId);
	if (!target || !(await pi.setModel(target))) {
		ctx.ui.notify(`guard: could not switch to ${row.account.provider} ${row.modelId}.`, "error");
		return false;
	}
	ctx.ui.notify(noticeOf(row), "info");
	return true;
}

/** The models of every account with auth configured now, grouped per Account in registry order. */
export function offersOf(ctx: ExtensionContext): ModelOffer[] {
	const offers: ModelOffer[] = [];
	for (const model of ctx.modelRegistry.getAvailable()) {
		const account = accountOfModel(ctx, model);
		const offer = offers.find((candidate) => sameAccount(candidate.account, account));
		if (offer) offer.modelIds.push(model.id);
		else offers.push({ account, modelIds: [model.id] });
	}
	return offers;
}
