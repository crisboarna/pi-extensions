import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandEnv } from "../core/dynamic.ts";
import type { UrlEnv } from "../core/url.ts";

const STATUS_KEY = "pi-context-refs";

// Esc as a terminal sends it: the lone byte, or the key-press form of the kitty keyboard protocol.
const ESC = String.fromCharCode(27);
const ESCAPE_KEYS = new Set([ESC, `${ESC}[27u`, `${ESC}[27;1u`, `${ESC}[27:1u`, `${ESC}[27;1:1u`]);

/** A send whose commands and fetches the user can cancel, and the runners to give them. */
export interface CommandRun {
	runCommand: CommandEnv["runCommand"];
	fetchUrl: UrlEnv["fetchUrl"];
	/** Aborted when the user presses Esc while a command runs or a page is fetched. */
	signal: AbortSignal;
	/** Clears the status and stops listening to the keyboard. */
	finish(): void;
}

/** Wraps `runCommand` and `fetchUrl` so the TUI shows "running #x…" while one runs and Esc cancels them all. Outside the TUI it only passes them through. */
export function trackRun(ctx: ExtensionContext, runCommand: CommandEnv["runCommand"], fetchUrl: UrlEnv["fetchUrl"]): CommandRun {
	const controller = new AbortController();
	const running = new Map<string, number>();
	let stopListening: (() => void) | undefined;
	const inTui = ctx.mode === "tui";

	const showStatus = (): void => {
		if (!inTui) return;
		ctx.ui.setStatus(STATUS_KEY, running.size === 0 ? undefined : `running ${[...running.keys()].map((name) => `#${name}`).join(" ")}… (esc cancels)`);
	};

	/** Runs `call` as the Ref `name`, with the status shown and Esc listened to for as long as it takes. */
	const tracked = async <Result>(name: string, call: (signal: AbortSignal) => Promise<Result>): Promise<Result> => {
		if (inTui) {
			stopListening ??= ctx.ui.onTerminalInput((data) => {
				if (!ESCAPE_KEYS.has(data)) return undefined;
				controller.abort();
				return { consume: true };
			});
		}
		running.set(name, (running.get(name) ?? 0) + 1);
		showStatus();
		try {
			return await call(controller.signal);
		} finally {
			const left = (running.get(name) ?? 1) - 1;
			if (left === 0) running.delete(name);
			else running.set(name, left);
			showStatus();
		}
	};

	return {
		signal: controller.signal,
		runCommand: (request) => tracked(request.name, (signal) => runCommand({ ...request, signal })),
		fetchUrl: (request) => tracked(request.name, (signal) => fetchUrl({ ...request, signal })),
		finish() {
			stopListening?.();
			stopListening = undefined;
			running.clear();
			showStatus();
		},
	};
}
