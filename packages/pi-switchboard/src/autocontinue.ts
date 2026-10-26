import { type Clock, systemClock } from "./util/runtime.ts";

export interface TimerApi {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const systemTimers: TimerApi = {
	set: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Seconds after the reset, so the provider has surely lifted the limit. */
const GRACE_MS = 5_000;

export interface AutoContinueOptions {
	/** Read on every schedule, so a reloaded config takes effect. */
	enabled: () => boolean;
	maxWaitMs: () => number;
	/** Sends the user message `continue`. */
	send: () => void;
	notify: (message: string) => void;
	clock?: Clock;
	timers?: TimerApi;
}

/**
 * Opt-in (DESIGN.md 9.6): when every model is cooling down, sends `continue`
 * once at the earliest reset. It is the only place pi-switchboard speaks for
 * the user, so it fires at most once per exhaustion, never waits longer than
 * `maxWaitMs`, and can be cancelled.
 */
export class AutoContinue {
	private readonly options: AutoContinueOptions;
	private readonly clock: Clock;
	private readonly timers: TimerApi;
	private handle: unknown;
	/** When the pending `continue` fires, epoch ms. */
	at?: number;

	constructor(options: AutoContinueOptions) {
		this.options = options;
		this.clock = options.clock ?? systemClock;
		this.timers = options.timers ?? systemTimers;
	}

	get pending(): boolean {
		return this.at !== undefined;
	}

	/** Schedules `continue` for the reset time; returns whether one is now pending. */
	schedule(resetAt: number): boolean {
		if (!this.options.enabled() || this.pending) return this.pending;
		const wait = resetAt - this.clock.now() + GRACE_MS;
		if (wait <= 0) return false;
		if (wait > this.options.maxWaitMs()) {
			this.options.notify(`the earliest reset is ${Math.round(wait / 60_000)} min away, beyond the ${Math.round(this.options.maxWaitMs() / 60_000)} min limit; not waiting`);
			return false;
		}
		this.at = this.clock.now() + wait;
		this.options.notify(`will send "continue" at ${new Date(this.at).toLocaleTimeString()}; /tier resume cancel stops it`);
		this.handle = this.timers.set(() => {
			this.handle = undefined;
			this.at = undefined;
			this.options.send();
		}, wait);
		return true;
	}

	cancel(): void {
		if (this.handle !== undefined) this.timers.clear(this.handle);
		this.handle = undefined;
		this.at = undefined;
	}
}
