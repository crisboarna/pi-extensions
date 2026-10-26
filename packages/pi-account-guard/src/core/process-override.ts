import type { BlockCause } from "./decide.ts";

/** The environment variable of the process Override (DESIGN.md section 10). */
export const PROCESS_OVERRIDE_VARIABLE = "PI_ACCOUNT_GUARD_ALLOW_UNKNOWN";

/** The run modes pi reports in `ctx.mode`; the process Override is honoured in all but `tui`. */
const HEADLESS_MODES = ["print", "json", "rpc"];

/** The process Override holds when the variable is exactly `1` in print, JSON or RPC mode. The TUI ignores it. An unknown mode ignores it too. */
export function processOverrideActive(value: string | undefined, mode: string | undefined): boolean {
	return value === "1" && mode !== undefined && HEADLESS_MODES.includes(mode);
}

/** The process Override lets through only an account in the Unknown zone: never a tagged account that fails to Match, never an undecidable case. */
export function processOverrideCovers(cause: BlockCause): cause is Extract<BlockCause, { kind: "unknown-account" }> {
	return cause.kind === "unknown-account";
}
