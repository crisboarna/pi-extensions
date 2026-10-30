import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandEnv } from "../core/dynamic.ts";

const STATUS_KEY = "pi-context-refs";

// Esc as a terminal sends it: the lone byte, or the key-press form of the kitty keyboard protocol.
const ESC = String.fromCharCode(27);
const ESCAPE_KEYS = new Set([ESC, `${ESC}[27u`, `${ESC}[27;1u`, `${ESC}[27:1u`, `${ESC}[27;1:1u`]);

/** A send whose commands the user can cancel, and the runner to give them. */
export interface CommandRun {
	runCommand: CommandEnv["runCommand"];
	/** Aborted when the user presses Esc while a command runs. */
	signal: AbortSignal;
	/** Clears the status and stops listening to the keyboard. */
	finish(): void;
}

/** Wraps `runCommand` so the TUI shows "running #x…" while a command runs and Esc cancels them all. Outside the TUI it only passes the commands through. */
export function trackRun(ctx: ExtensionContext, runCommand: CommandEnv["runCommand"]): CommandRun {
	const controller = new AbortController();
	const running = new Map<string, number>();
	let stopListening: (() => void) | undefined;
	const inTui = ctx.mode === "tui";

	const showStatus = (): void => {
		if (!inTui) return;
		ctx.ui.setStatus(STATUS_KEY, running.size === 0 ? undefined : `running ${[...running.keys()].map((name) => `#${name}`).join(" ")}… (esc cancels)`);
	};

	return {
		signal: controller.signal,
		async runCommand(request) {
			if (inTui) {
				stopListening ??= ctx.ui.onTerminalInput((data) => {
					if (!ESCAPE_KEYS.has(data)) return undefined;
					controller.abort();
					return { consume: true };
				});
			}
			running.set(request.name, (running.get(request.name) ?? 0) + 1);
			showStatus();
			try {
				return await runCommand({ ...request, signal: controller.signal });
			} finally {
				const left = (running.get(request.name) ?? 1) - 1;
				if (left === 0) running.delete(request.name);
				else running.set(request.name, left);
				showStatus();
			}
		},
		finish() {
			stopListening?.();
			stopListening = undefined;
			running.clear();
			showStatus();
		},
	};
}
