import { describeAccount } from "./account.ts";
import type { GuardConfig } from "./config.ts";
import { ruleLine } from "./place-edit.ts";

/** The config with a zone declared; a declared zone is left as it is. */
export function addZone(config: GuardConfig, zone: string): GuardConfig {
	return config.zones.includes(zone) ? config : { ...config, zones: [...config.zones, zone] };
}

/** The config without a declared zone. The caller has checked that nothing references the zone. */
export function removeZone(config: GuardConfig, zone: string): GuardConfig {
	return { ...config, zones: config.zones.filter((declared) => declared !== zone) };
}

/** The config with a zone renamed everywhere: the declaration, the tags, the rules and the default zone. */
export function renameZone(config: GuardConfig, oldName: string, newName: string): GuardConfig {
	const rename = (zone: string) => (zone === oldName ? newName : zone);
	return {
		zones: config.zones.map(rename),
		defaultZone: rename(config.defaultZone),
		accounts: config.accounts.map((account) => ({ ...account, zones: account.zones.map(rename) })),
		places: config.places.map((rule) => ({ ...rule, zone: rename(rule.zone) })),
	};
}

/** The config with another default zone. */
export function setDefaultZone(config: GuardConfig, zone: string): GuardConfig {
	return { ...config, defaultZone: zone };
}

/** What still names the zone: tags, rules (numbered in file order) and the default zone, one line each. */
export function zoneReferences(config: GuardConfig, zone: string): string[] {
	return [
		...config.accounts.filter((account) => account.zones.includes(zone)).map((account) => `tag ${describeAccount(account)}`),
		...config.places.flatMap((rule, index) => (rule.zone === zone ? [`rule ${index + 1}: ${ruleLine(rule)}`] : [])),
		...(config.defaultZone === zone ? ["the default zone"] : []),
	];
}
