import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionEntry } from "./types.ts";

export interface DebugLogOptions {
	path: string;
	maxBytes: number;
	maxFiles: number;
	fullEvidence: boolean;
}

/**
 * Opt-in JSONL debug log, one decision per line, rotated by size. Evidence
 * is kept to its digest and excerpt unless `fullEvidence` is on; the
 * excerpt is already redacted.
 */
export class DebugLog {
	private readonly options: DebugLogOptions;

	constructor(options: DebugLogOptions) {
		this.options = options;
	}

	write(decision: DecisionEntry, context: { session: string; cwd: string }, evidence?: Record<string, unknown>): void {
		const { path, maxBytes, maxFiles } = this.options;
		try {
			mkdirSync(dirname(path), { recursive: true });
			if (existsSync(path) && statSync(path).size > maxBytes) this.rotate(path, maxFiles);
			const line = {
				...decision,
				session: context.session,
				cwd: context.cwd,
				...(this.options.fullEvidence && evidence ? { fullEvidence: evidence } : {}),
			};
			appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
		} catch {
			// Debugging aid only.
		}
	}

	private rotate(path: string, maxFiles: number): void {
		rmSync(`${path}.${maxFiles}`, { force: true });
		for (let i = maxFiles - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
		renameSync(path, `${path}.1`);
	}
}
