import type { GuardConfig, PlaceRuleEntry } from "./config.ts";
import type { PlaceOutcome } from "./decide.ts";
import { ruleText } from "./status.ts";

/** The config with a rule inserted so that it ends at `index` (0 is the top). */
export function addPlaceRule(config: GuardConfig, rule: PlaceRuleEntry, index: number): GuardConfig {
	return { ...config, places: [...config.places.slice(0, index), rule, ...config.places.slice(index)] };
}

/** The config without the rule at `index`. */
export function removePlaceRule(config: GuardConfig, index: number): GuardConfig {
	return { ...config, places: config.places.filter((_, at) => at !== index) };
}

/** The config with the rule at `from` taken out and put back so that it ends at `to`. */
export function movePlaceRule(config: GuardConfig, from: number, to: number): GuardConfig {
	const rule = config.places[from]!;
	return addPlaceRule(removePlaceRule(config, from), rule, to);
}

/** The rule as one line of a list or a dialog: its conditions and its zone. */
export function ruleLine(rule: PlaceRuleEntry): string {
	return `${ruleText(rule)} -> ${rule.zone}`;
}

/** The numbered rules in file order, marking the one that decides the place; read-only (DESIGN.md section 11). */
export function placeListText(config: GuardConfig, place: PlaceOutcome): string {
	const deciding = place.ok ? place.ruleIndex : undefined;
	const mark = (decides: boolean) => (decides ? "   <- decides this place" : "");
	const rules = config.places.map((rule, index) => ` ${index + 1}. ${ruleLine(rule)}${mark(deciding === index)}`);
	const fallback = ` default zone: ${config.defaultZone}${mark(place.ok && place.ruleIndex === undefined)}`;
	const header = place.ok ? [] : [` this place cannot be decided: ${place.reason}`];
	return ["guard place rules", ...header, ...(rules.length > 0 ? rules : [" no rules"]), fallback].join("\n");
}

/** Whether moving from the place `before` to the place `after` changes the zone the guard decides with. */
export function placeZoneChanges(before: PlaceOutcome, after: PlaceOutcome): boolean {
	if (before.ok && after.ok) return before.zone !== after.zone;
	return before.ok !== after.ok;
}

const zoneOf = (place: PlaceOutcome) => (place.ok ? `zone ${place.zone}` : `unknown (${place.reason})`);

/** One sentence for the confirm of an edit that changes the zone of this place. */
export function placeChangeText(before: PlaceOutcome, after: PlaceOutcome): string {
	return `This place changes from ${zoneOf(before)} to ${zoneOf(after)}.`;
}
