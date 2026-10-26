import { sameAccount, type AccountKey } from "./account.ts";
import { parseConfig, type ConfigError, type ConfigResult, type GuardConfig } from "./config.ts";

/** The file text of a config: every default spelled out, 2-space indent, one final newline (DESIGN.md section 4). */
export function serializeConfig(config: GuardConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

/** The config with the zones of one account set: an untagged account is appended, a tagged one keeps its note and position. */
export function setAccountZones(config: GuardConfig, key: AccountKey, zones: string[]): GuardConfig {
	const tagged = config.accounts.some((account) => sameAccount(account, key));
	const accounts = tagged
		? config.accounts.map((account) => (sameAccount(account, key) ? { ...account, zones } : account))
		: [...config.accounts, { provider: key.provider, source: key.source, zones }];
	return { ...config, accounts };
}

/** The config without the tag of one account; the account becomes Unknown. */
export function removeAccount(config: GuardConfig, key: AccountKey): GuardConfig {
	return { ...config, accounts: config.accounts.filter((account) => !sameAccount(account, key)) };
}

export type WriteOutcome = { ok: true; config: GuardConfig } | { ok: false; errors: ConfigError[] };

export interface ConfigWriter {
	/**
	 * Re-reads the file, applies `change` to what was read and writes the result.
	 * Refuses, writing nothing, when the file is malformed or when the changed config would not validate.
	 */
	update(change: (config: GuardConfig) => GuardConfig): WriteOutcome;
}

export interface ConfigWriterDeps {
	/** Reads the file live with no fallback to a last valid copy. */
	readForWrite(): ConfigResult;
	/** Replaces the file; must be atomic, and creates the file when it is missing. */
	writeText(text: string): void;
}

/** The one way the guard changes `account-guard.json`: re-read, change, validate, write (DESIGN.md section 4). */
export function createConfigWriter({ readForWrite, writeText }: ConfigWriterDeps): ConfigWriter {
	return {
		update(change) {
			const current = readForWrite();
			if (!current.ok) return current;
			const text = serializeConfig(change(current.config));
			const next = parseConfig(text);
			if (!next.ok) return next;
			writeText(text);
			return next;
		},
	};
}
