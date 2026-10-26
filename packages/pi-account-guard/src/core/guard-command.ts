import { parseZoneList } from "./tag-prompt.ts";

export const TAG_USAGE = "/guard tag [provider [source] [zones]]";
export const UNTAG_USAGE = "/guard untag [provider [source]]";

export const PLACE_ADD_USAGE = "/guard place add [path=<path|here>] [remote=<glob>] [zone=<zone>] [at=<n>]";
export const PLACE_LIST_USAGE = "/guard place list";
export const PLACE_REMOVE_USAGE = "/guard place remove [<n>]";
export const PLACE_MOVE_USAGE = "/guard place move [<n> <to>]";
export const ZONE_ADD_USAGE = "/guard zone add [<name>]";
export const ZONE_REMOVE_USAGE = "/guard zone remove [<zone>]";
export const ZONE_RENAME_USAGE = "/guard zone rename [<old> <new>]";
export const ZONE_DEFAULT_USAGE = "/guard zone default [<zone>]";

/** The usage of `/guard`, one line per command. */
export const GUARD_USAGE = [
	"Usage:",
	"  /guard",
	`  ${TAG_USAGE}`,
	`  ${UNTAG_USAGE}`,
	`  ${PLACE_ADD_USAGE}`,
	`  ${PLACE_LIST_USAGE}`,
	`  ${PLACE_REMOVE_USAGE}`,
	`  ${PLACE_MOVE_USAGE}`,
	`  ${ZONE_ADD_USAGE}`,
	`  ${ZONE_REMOVE_USAGE}`,
	`  ${ZONE_RENAME_USAGE}`,
	`  ${ZONE_DEFAULT_USAGE}`,
].join("\n");

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
	return { provider, ...(source === undefined ? {} : { source }), ...(zones.length > 0 ? { zonesText: zones.join(" ") } : {}) };
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

export interface PlaceAddArguments {
	/** An absolute or `~` path, or `here` for the directory of this place. */
	path?: string;
	remote?: string;
	zone?: string;
	/** The position the new rule takes, as typed. */
	at?: string;
}

/** Reads the `key=value` words after `place add`; an unknown key, a repeated key or an empty value makes the arguments invalid. */
export function parsePlaceAddArguments(words: string[]): PlaceAddArguments | undefined {
	const named: PlaceAddArguments = {};
	for (const word of words) {
		const equals = word.indexOf("=");
		const key = word.slice(0, equals);
		const value = word.slice(equals + 1);
		if (equals < 0 || value === "" || !(key === "path" || key === "remote" || key === "zone" || key === "at") || named[key] !== undefined) return undefined;
		named[key] = value;
	}
	return named;
}

/** Reads a 1-based number between 1 and `max`; `undefined` for anything else. */
export function parseNumber(text: string, max: number): number | undefined {
	const number = /^\d+$/.test(text) ? Number(text) : undefined;
	return number !== undefined && number >= 1 && number <= max ? number : undefined;
}

/** Why a zone name cannot be used, or `undefined` when it can: a comma would split it in a zone list. */
export function zoneNameProblem(name: string): string | undefined {
	return name.includes(",") ? `A zone name cannot contain a comma: ${name}.` : undefined;
}
