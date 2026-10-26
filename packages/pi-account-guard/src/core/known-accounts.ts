import { type AccountKey, describeAccount, sameAccount } from "./account.ts";
import type { AccountTag } from "./config.ts";

/** An Account the guard can list: configured in pi now, tagged in the file, or both. */
export interface KnownAccount {
	key: AccountKey;
	/** The tagged zones; `undefined` when the account has no tag (the Unknown zone). */
	zones: string[] | undefined;
	/** The provider has auth configured now at this source. */
	configured: boolean;
}

/** Every provider id with configured auth at its current source, in registry order, then every file entry not configured now, in file order. */
export function knownAccounts(configured: AccountKey[], tags: AccountTag[]): KnownAccount[] {
	const zonesOf = (key: AccountKey) => tags.find((tag) => sameAccount(tag, key))?.zones;
	return [
		...configured.map((key) => ({ key, zones: zonesOf(key), configured: true })),
		...tags
			.filter((tag) => !configured.some((key) => sameAccount(key, tag)))
			.map((tag) => ({ key: { provider: tag.provider, source: tag.source }, zones: tag.zones, configured: false })),
	];
}

/** The picker row of an account: its key, its zones or `untagged`, and a mark when it is not configured now. */
export function knownAccountLabel({ key, zones, configured }: KnownAccount): string {
	return `${describeAccount(key)}  [${zones ? zones.join(", ") : "untagged"}]${configured ? "" : "  (not configured now)"}`;
}
