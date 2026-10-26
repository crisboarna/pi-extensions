import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigResult } from "../core/config.ts";
import { logData, type DialogCause } from "../core/block-dialog.ts";
import type { Decision, PlaceOutcome } from "../core/decide.ts";
import { headlessBlockMessage, type MessageContext } from "../core/messages.ts";
import { blockedBeforeSendNotice, failoverBlockedNotice, type PreviousModel } from "../core/mid-turn.ts";
import { applyOverrides } from "../core/overrides.ts";
import { accountOfModel } from "./account-of.ts";
import { abortOnError } from "./handler-errors.ts";
import type { OverrideStore } from "./interactive-block.ts";
import { runMidTurnBlock } from "./mid-turn-block.ts";

/** The decision for the model in `ctx`, with the place and config it was made on. */
interface Evaluation {
	decision: Decision;
	place: PlaceOutcome;
	config: ConfigResult;
}

export interface ModelGuardDeps {
	/** Evaluates `ctx.model`; `undefined` when no model is selected. */
	evaluate(ctx: ExtensionContext): Evaluation | undefined;
	overrides: OverrideStore;
	messages: MessageContext;
	writeStderr(text: string): void;
	/** Writes the text to stderr and sets the Block exit code (ADR 0005). */
	failHeadless(text: string): void;
}

interface BlockedModel {
	cause: DialogCause;
	place: PlaceOutcome;
	config: ConfigResult;
}

/**
 * The two checks besides `input` (DESIGN.md section 8): a model change while a turn runs, and the idle re-check in `before_agent_start`.
 * The guard never switches the model by itself, and never resumes an aborted turn.
 */
export function registerModelGuard(pi: ExtensionAPI, deps: ModelGuardDeps): void {
	// Set when a mid-turn change aborted the turn; the select opens at `agent_settled`, once pi is idle.
	let recheck: { previous: PreviousModel | undefined } | undefined;

	function blockedModel(ctx: ExtensionContext): BlockedModel | undefined {
		const checked = deps.evaluate(ctx);
		if (!checked) return undefined;
		const verdict = applyOverrides(checked.decision, checked.place, deps.overrides.current());
		if (verdict.verdict !== "block") return undefined;
		if (verdict.cause.kind === "internal-error") throw new Error(verdict.cause.reason);
		return { cause: verdict.cause, place: checked.place, config: checked.config };
	}

	pi.on("session_start", () => {
		recheck = undefined;
	});

	// A user turn after the abort (a retry that multi-pass sends) is Blocked by `input` with its own select, so the idle select would repeat it.
	pi.on("input", () => {
		recheck = undefined;
	});

	// Evaluates ctx.model, not event.model: nested emissions leave the event's model stale.
	pi.on(
		"model_select",
		abortOnError(pi, "model_select", deps.writeStderr, (event, ctx) => {
			// Idle: nothing to abort; the next `input` or `before_agent_start` Blocks.
			if (ctx.isIdle()) return;
			const blocked = blockedModel(ctx);
			if (!blocked) return;
			ctx.abort();
			// A nested emission aborts again but announces once.
			if (recheck) return;
			recheck = { previous: event.previousModel && { account: accountOfModel(ctx, event.previousModel), modelId: event.previousModel.id } };
			pi.appendEntry("guard.block", logData(blocked.cause, blocked.place));
			const notice = failoverBlockedNotice(blocked.cause, blocked.place, deps.messages);
			if (ctx.hasUI) ctx.ui.notify(notice, "error");
			else deps.failHeadless(`${notice}\n`);
		}),
	);

	pi.on(
		"agent_settled",
		abortOnError(pi, "agent_settled", deps.writeStderr, async (_event, ctx) => {
			const pending = recheck;
			recheck = undefined;
			if (!pending || !ctx.hasUI) return;
			const blocked = blockedModel(ctx);
			if (!blocked) return;
			await runMidTurnBlock({
				pi,
				ctx,
				cause: blocked.cause,
				place: blocked.place,
				config: blocked.config.ok ? blocked.config.config : undefined,
				previous: pending.previous,
				overrides: deps.overrides,
				messages: deps.messages,
			});
		}),
	);

	// Catches an Account switched while idle and a run started by `pi.sendMessage` with `triggerTurn`: check every start, whatever `messageType` says.
	pi.on(
		"before_agent_start",
		abortOnError(pi, "before_agent_start", deps.writeStderr, (_event, ctx) => {
			const blocked = blockedModel(ctx);
			if (!blocked) return;
			ctx.abort();
			pi.appendEntry("guard.block", logData(blocked.cause, blocked.place));
			if (ctx.hasUI) ctx.ui.notify(blockedBeforeSendNotice(blocked.cause, blocked.place, deps.messages), "error");
			else deps.failHeadless(headlessBlockMessage(blocked.cause, deps.messages));
		}),
	);
}
