import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logData } from "../core/block-dialog.ts";
import type { ConfigResult } from "../core/config.ts";
import type { BlockCause, Decision, PlaceOutcome } from "../core/decide.ts";
import { headlessBlockMessage, type MessageContext } from "../core/messages.ts";
import { blockedBeforeSendNotice, failoverBlockedNotice, type PreviousModel } from "../core/mid-turn.ts";
import { applyOverrides, releaseOnce } from "../core/overrides.ts";
import type { AccountOfModel } from "./account-of.ts";
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
	/** Evaluates `ctx.model`; `undefined` when no model is selected. `startsTurn` is set when a turn is about to start. */
	evaluate(ctx: ExtensionContext, startsTurn: boolean): Evaluation | undefined;
	overrides: OverrideStore;
	messages: MessageContext;
	/** Writes the text to stderr and sets the Block exit code (ADR 0005). */
	failHeadless(text: string): void;
	accountOfModel: AccountOfModel;
}

interface BlockedModel {
	cause: BlockCause;
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

	/** Allow once ends with its turn; a turn that is aborted or never starts does not reach `agent_end` (DESIGN.md section 10). */
	function releaseOnceGrant(ctx: ExtensionContext): void {
		deps.overrides.replace(releaseOnce(deps.overrides.current()), ctx);
	}

	function blockedModel(ctx: ExtensionContext, startsTurn = false): BlockedModel | undefined {
		const checked = deps.evaluate(ctx, startsTurn);
		if (!checked) return undefined;
		const verdict = applyOverrides(checked.decision, checked.place, deps.overrides.current());
		if (verdict.verdict !== "block") return undefined;
		if (verdict.cause.kind === "internal-error") throw new Error(verdict.cause.reason);
		return { cause: verdict.cause, place: checked.place, config: checked.config };
	}

	pi.on(
		"session_start",
		abortOnError(pi, "session_start", deps.failHeadless, () => {
			recheck = undefined;
		}),
	);

	// A user turn after the abort (a retry that multi-pass sends) is Blocked by `input` with its own select, so the idle select would repeat it.
	pi.on(
		"input",
		abortOnError(pi, "input", deps.failHeadless, () => {
			recheck = undefined;
		}),
	);

	// Evaluates ctx.model, not event.model: nested emissions leave the event's model stale.
	pi.on(
		"model_select",
		abortOnError(pi, "model_select", deps.failHeadless, (event, ctx) => {
			// Idle: nothing to abort; the next `input` or `before_agent_start` Blocks.
			if (ctx.isIdle()) return;
			const blocked = blockedModel(ctx);
			if (!blocked) return;
			ctx.abort();
			releaseOnceGrant(ctx);
			// A nested emission aborts again but announces once.
			if (recheck) return;
			recheck = { previous: event.previousModel && { account: deps.accountOfModel(ctx, event.previousModel), modelId: event.previousModel.id } };
			pi.appendEntry("guard.block", logData(blocked.cause, blocked.place));
			const notice = failoverBlockedNotice(blocked.cause, blocked.place, deps.messages);
			if (ctx.hasUI) ctx.ui.notify(notice, "error");
			else deps.failHeadless(`${notice}\n`);
		}),
	);

	pi.on(
		"agent_settled",
		abortOnError(pi, "agent_settled", deps.failHeadless, async (_event, ctx) => {
			releaseOnceGrant(ctx);
			const pending = recheck;
			recheck = undefined;
			if (!pending || !ctx.hasUI) return;
			const blocked = blockedModel(ctx);
			if (!blocked) return;
			await runMidTurnBlock({
				pi,
				ctx,
				accountOfModel: deps.accountOfModel,
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
		abortOnError(pi, "before_agent_start", deps.failHeadless, (_event, ctx) => {
			const blocked = blockedModel(ctx, true);
			if (!blocked) return;
			ctx.abort();
			releaseOnceGrant(ctx);
			pi.appendEntry("guard.block", logData(blocked.cause, blocked.place));
			if (ctx.hasUI) ctx.ui.notify(blockedBeforeSendNotice(blocked.cause, blocked.place, deps.messages), "error");
			else deps.failHeadless(headlessBlockMessage(blocked.cause, deps.messages));
		}),
	);
}
