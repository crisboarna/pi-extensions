import { parseConfig, type ConfigError, type ConfigResult, type GuardConfig } from "./config.ts";

export interface ConfigSnapshot {
	/** What the checks decide with: the live file, or the last valid copy while the file is malformed. */
	result: ConfigResult;
	/** Set once per session, on the first read that falls back to the last valid copy. */
	warning?: { errors: ConfigError[] };
}

export interface ConfigState {
	/** Reads the file live (DESIGN.md section 4); a malformed file falls back to the last valid copy of this session. */
	load(): ConfigSnapshot;
	/** Reads the file live with no fallback. A writer must refuse when this is not ok: the guard never writes over a malformed file. */
	readForWrite(): ConfigResult;
	/** Forgets the last valid copy and the warning; a new session starts clean. */
	reset(): void;
}

const readFailure = (error: unknown): ConfigResult => ({
	ok: false,
	errors: [{ path: "", message: `cannot read the file: ${error instanceof Error ? error.message : String(error)}` }],
});

/** Holds the last valid config of one session. `readText` returns `undefined` for a missing file and may throw. */
export function createConfigState(readText: () => string | undefined): ConfigState {
	let lastValid: GuardConfig | undefined;
	let warned = false;

	function readLive(): ConfigResult {
		try {
			return parseConfig(readText());
		} catch (error) {
			return readFailure(error);
		}
	}

	return {
		load() {
			const live = readLive();
			if (live.ok) {
				lastValid = live.config;
				return { result: live };
			}
			if (lastValid === undefined) return { result: live };
			const snapshot: ConfigSnapshot = { result: { ok: true, config: lastValid } };
			if (!warned) {
				warned = true;
				snapshot.warning = { errors: live.errors };
			}
			return snapshot;
		},
		readForWrite: readLive,
		reset() {
			lastValid = undefined;
			warned = false;
		},
	};
}
