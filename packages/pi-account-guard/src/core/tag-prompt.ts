import type { AccountKey } from "./account.ts";
import { zonePhrase } from "./messages.ts";

/** The select entry of the RPC tag prompt that opens a free-text input for several zones. */
export const SEVERAL_ZONES_OPTION = "Several zones…";

/** The auth source of an Account in words (DESIGN.md section 6). A source this list does not know is shown as it is. */
function sourceInWords(source: string): string {
	switch (source) {
		case "oauth":
			return "OAuth login";
		case "stored-key":
			return "saved API key";
		case "models-json-key":
			return "key in models.json";
		case "models-json-command":
			return "command in models.json";
		case "runtime":
			return "runtime key";
		case "fallback":
			return "fallback key";
		case "unconfigured":
			return "no credentials";
		case "claude-code":
			return "Claude Code cloud login";
	}
	if (source.startsWith("env:")) return `environment variable ${source.slice("env:".length)}`;
	if (source.startsWith("claude-config:")) return `Claude Code login ${source.slice("claude-config:".length)}`;
	return source;
}

/** `<provider id> · <source in words>`, followed by any pi-multi-pass label as a hint (DESIGN.md section 6). */
export function accountInWords(account: AccountKey, multiPassLabel?: string): string {
	const words = `${account.provider} · ${sourceInWords(account.source)}`;
	return multiPassLabel === undefined ? words : `${words} (multi-pass: ${multiPassLabel})`;
}

/** The question of the Tag prompt; it states the zone of the place (DESIGN.md section 10.1). */
export function tagPromptTitle(account: AccountKey, placeZone: string, multiPassLabel?: string): string {
	return `This place is ${placeZone}. Which zones does ${accountInWords(account, multiPassLabel)} belong to?`;
}

export type ZoneListResult = { ok: true; zones: string[] } | { ok: false; message: string };

/** Reads the comma-separated zone names typed into the RPC input; every name must be a declared zone. */
export function parseZoneList(text: string, declared: string[]): ZoneListResult {
	const names = [...new Set(text.split(",").map((name) => name.trim()).filter((name) => name !== ""))];
	if (names.length === 0) return { ok: false, message: "Name at least one zone." };
	const undeclared = names.filter((name) => !declared.includes(name));
	if (undeclared.length > 0) return { ok: false, message: `Not a declared zone: ${undeclared.join(", ")}. Declared zones: ${declared.join(", ")}.` };
	return { ok: true, zones: names };
}

const WORD_CHARACTER = "\\p{L}\\p{N}_";

/** The declared zones a label names as a whole word, ignoring case: "Work seat" names `work`, "Network" names nothing. */
export function zonesNamedInLabel(label: string, declared: string[]): string[] {
	return declared.filter((zone) => new RegExp(`(?<![${WORD_CHARACTER}])${zone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![${WORD_CHARACTER}])`, "iu").test(label));
}

export interface BypassNudgeInput {
	account: AccountKey;
	multiPassLabel: string | undefined;
	/** The zones the user chose. */
	chosen: string[];
	declared: string[];
}

/** The extra confirm asked when the label names a zone the chosen zones leave out; `undefined` when no confirm is needed. */
export function bypassNudge({ account, multiPassLabel, chosen, declared }: BypassNudgeInput): { title: string; message: string } | undefined {
	if (multiPassLabel === undefined) return undefined;
	const leftOut = zonesNamedInLabel(multiPassLabel, declared).filter((zone) => !chosen.includes(zone));
	if (leftOut.length === 0) return undefined;
	return {
		title: `Tag as ${chosen.join(", ")}?`,
		message: `The pi-multi-pass label of ${accountInWords(account)} is "${multiPassLabel}", which names ${zonePhrase(leftOut)}, but you chose ${chosen.join(", ")}. Tag it anyway?`,
	};
}
