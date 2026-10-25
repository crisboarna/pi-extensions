import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitAccountProvider } from "../util/model-ref.ts";

export interface Subscription {
	provider: string;
	index: number;
	label?: string;
}

/** pi-multi-pass accounts from `multi-pass.json` and `MULTI_SUB`; read-only, never written. */
export function readMultiPassSubscriptions(agentDir: string, env: NodeJS.ProcessEnv = process.env): Subscription[] {
	const subscriptions: Subscription[] = [];
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8")) as { subscriptions?: unknown };
		if (Array.isArray(raw.subscriptions)) {
			for (const entry of raw.subscriptions) {
				if (entry && typeof entry.provider === "string" && Number.isInteger(entry.index)) {
					subscriptions.push({ provider: entry.provider, index: entry.index, ...(typeof entry.label === "string" ? { label: entry.label } : {}) });
				}
			}
		}
	} catch {
		// No multi-pass config.
	}
	for (const part of (env.MULTI_SUB ?? "").split(",")) {
		const [provider, count] = part.trim().split(":");
		const n = Number(count);
		if (!provider || !Number.isInteger(n)) continue;
		for (let index = 2; index <= n; index++) {
			if (!subscriptions.some((s) => s.provider === provider && s.index === index)) subscriptions.push({ provider, index });
		}
	}
	return subscriptions;
}

/**
 * Providers serving the same models as `provider` through other accounts:
 * the base provider and every `<base>-<n>`, excluding `provider` itself.
 */
export function accountSiblings(provider: string, subscriptions: readonly Subscription[], isProvider: (name: string) => boolean): string[] {
	const { base } = splitAccountProvider(provider, isProvider);
	const all = [base, ...subscriptions.filter((s) => s.provider === base).map((s) => `${base}-${s.index}`)];
	return [...new Set(all)].filter((name) => name !== provider && isProvider(name));
}

/** `provider` mapped onto the account a session last used for the same base provider. */
export function mapToAccount(provider: string, lastAccountByBase: Readonly<Record<string, string>>, isProvider: (name: string) => boolean): string {
	const { base } = splitAccountProvider(provider, isProvider);
	const account = lastAccountByBase[base];
	return account && isProvider(account) ? account : provider;
}

export function accountLabel(provider: string, subscriptions: readonly Subscription[], isProvider: (name: string) => boolean): string | undefined {
	const { base, index } = splitAccountProvider(provider, isProvider);
	if (index === undefined) return subscriptions.some((s) => s.provider === base) ? "#1" : undefined;
	return subscriptions.find((s) => s.provider === base && s.index === index)?.label ?? `#${index}`;
}
