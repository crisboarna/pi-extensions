import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handlerErrorNotice } from "../core/messages.ts";

/** Session log entry type of a failed guard handler. */
export const HANDLER_ERROR_ENTRY = "guard.error";

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Logs the error in the session. Never throws: it runs while the guard is already failing. */
export function logHandlerError(pi: ExtensionAPI, handler: string, error: unknown): void {
	try {
		pi.appendEntry(HANDLER_ERROR_ENTRY, { handler, reason: errorText(error) });
	} catch {
		// The user is told separately.
	}
}

/** Logs the error in the session and tells the user. Never throws. */
export function reportHandlerError(pi: ExtensionAPI, ctx: ExtensionContext, handler: string, error: unknown, writeStderr: (text: string) => void): void {
	logHandlerError(pi, handler, error);
	const notice = handlerErrorNotice(handler, errorText(error));
	try {
		if (ctx.hasUI) ctx.ui.notify(notice, "error");
		else writeStderr(`${notice}\n`);
	} catch {
		// Nothing left to tell.
	}
}

/**
 * Wraps a handler that returns nothing: when it throws, the error is reported and the run is aborted (DESIGN.md section 7).
 * pi swallows hook errors and carries on, so no handler may fail open.
 */
export function abortOnError<Event>(
	pi: ExtensionAPI,
	handler: string,
	writeStderr: (text: string) => void,
	run: (event: Event, ctx: ExtensionContext) => void | Promise<void>,
): (event: Event, ctx: ExtensionContext) => Promise<void> {
	return async (event, ctx) => {
		try {
			await run(event, ctx);
		} catch (error) {
			reportHandlerError(pi, ctx, handler, error, writeStderr);
			try {
				ctx.abort();
			} catch {
				// Nothing to abort.
			}
		}
	};
}
