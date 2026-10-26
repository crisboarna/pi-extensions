import { parseZoneList } from "./tag-prompt.ts";

export const TAG_USAGE = "/guard tag [provider [source] [zones]]";
export const UNTAG_USAGE = "/guard untag [provider [source]]";

/** The usage of `/guard`, one line per command. */
export const GUARD_USAGE = ["Usage:", "  /guard", `  ${TAG_USAGE}`, `  ${UNTAG_USAGE}`].join("\n");

export interface AccountArguments {
	provider?: string;
	source?: string;
}

export interface TagArguments extends AccountArguments {
	/** The zone names as typed, comma-separated; not yet checked against the declared zones. */
	zonesText?: string;
}

/**
 * Reads the words after `tag`: `provider`, then an optional source, then the zones.
 * The second word is the zones when it is a comma list or names only declared zones; any other second word is the source.
 */
export function parseTagArguments(words: string[], declaredZones: string[]): TagArguments {
	const [provider, ...rest] = words;
	if (provider === undefined) return {};
	if (rest.length === 0) return { provider };
	const restText = rest.join(" ");
	const isZones = parseZoneList(restText, declaredZones).ok || (rest.length === 1 && restText.includes(","));
	if (isZones) return { provider, zonesText: restText };
	const [source, ...zones] = rest;
	return { provider, source, ...(zones.length > 0 ? { zonesText: zones.join(" ") } : {}) };
}

/** Reads the words after `untag`: `provider`, then an optional source; extra words make the arguments invalid. */
export function parseUntagArguments(words: string[]): AccountArguments | undefined {
	const [provider, source, ...extra] = words;
	if (extra.length > 0) return undefined;
	return { ...(provider === undefined ? {} : { provider }), ...(source === undefined ? {} : { source }) };
}

/** The old-to-new text of the confirm shown when a tag changes an account's zones. */
export function zoneChangeText(oldZones: string[], newZones: string[]): string {
	return `${oldZones.join(", ")} -> ${newZones.join(", ")}`;
}

/** Whether two zone lists name the same zones, whatever the order. */
export function sameZones(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((zone) => b.includes(zone));
}
