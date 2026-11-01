import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandEnv } from "../core/dynamic.ts";
import type { UrlEnv } from "../core/url.ts";

const STATUS_KEY = "pi-context-refs";

/** The sends in progress in this session: Esc cancels all of them, and each shows its own status. */
export interface SendSet {
	active: Set<AbortController>;
	/** True while another component wants Esc. */
	escapeTaken: () => boolean;
	started: number;
}

export function createSendSet(escapeTaken: () => boolean = () => false): SendSet {
	return { active: new Set(), escapeTaken, started: 0 };
}

// Esc as a terminal sends it: the lone byte, or the key-press form of the kitty keyboard protocol.
const ESC = String.fromCharCode(27);
const ESCAPE_KEYS = new Set([ESC, `${ESC}[27u`, `${ESC}[27;1u`, `${ESC}[27:1u`, `${ESC}[27;1:1u`]);

/** A send whose commands and fetches the user can cancel, and the runners to give them. */
export interface CommandRun {
	runCommand: CommandEnv["runCommand"];
	fetchUrl: UrlEnv["fetchUrl"];
	/** Aborted when the user presses Esc while a command runs or a page is fetched. */
	signal: AbortSignal;
	/** Cancels the commands and fetches, stops listening to the keyboard and never touches the UI again: for a session that is shutting down. */
	abort(): void;
	/** Clears the status and stops listening to the keyboard. */
	finish(): void;
}

/** Wraps `runCommand` and `fetchUrl` so the TUI shows "running #x…" while one runs and Esc cancels them all. Outside the TUI it only passes them through. */
export function trackRun(ctx: ExtensionContext, runCommand: CommandEnv["runCommand"], fetchUrl: UrlEnv["fetchUrl"], sends: SendSet): CommandRun {
	const controller = new AbortController();
	// The first send alone keeps the plain key; a send that starts while another runs gets its own, so neither clears the other's status.
	const statusKey = sends.active.size === 0 ? STATUS_KEY : `${STATUS_KEY}:${++sends.started}`;
	sends.active.add(controller);
	const running = new Map<string, number>();
	let stopListening: (() => void) | undefined;
	const inTui = ctx.mode === "tui";
	let released = false;

	const showStatus = (): void => {
		if (!inTui || released) return;
		ctx.ui.setStatus(statusKey, running.size === 0 ? undefined : `running ${[...running.keys()].map((name) => `#${name}`).join(" ")}… (esc cancels)`);
	};

	/** Runs `call` as the Ref `name`, with the status shown and Esc listened to for as long as it takes. */
	const tracked = async <Result>(name: string, call: (signal: AbortSignal) => Promise<Result>): Promise<Result> => {
		if (inTui && !released) {
			stopListening ??= ctx.ui.onTerminalInput((data) => {
				if (!ESCAPE_KEYS.has(data) || sends.escapeTaken()) return undefined;
				for (const active of sends.active) active.abort();
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
		abort() {
			released = true;
			sends.active.delete(controller);
			controller.abort();
			stopListening?.();
			stopListening = undefined;
		},
		finish() {
			sends.active.delete(controller);
			stopListening?.();
			stopListening = undefined;
			running.clear();
			showStatus();
		},
	};
}
