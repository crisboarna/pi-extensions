import { describeAccount, type AccountKey } from "./account.ts";
import { accountZones, formatConfigErrors, type ConfigError, type ConfigResult, type PlaceRuleEntry } from "./config.ts";
import { decide, type PlaceOutcome } from "./decide.ts";
import type { MessageContext } from "./messages.ts";
import type { Overrides } from "./overrides.ts";
import { displayPath } from "./place.ts";

export interface StatusInput extends MessageContext {
	/** The session cwd, shown when the place cannot be resolved. */
	cwd: string;
	place: PlaceOutcome;
	/** The Account of the current model; `undefined` when no model is selected. */
	account: AccountKey | undefined;
	/** What the checks decide with: the live file, or the last valid copy. */
	config: ConfigResult;
	/** The errors of the live file when it is malformed and `config` is the last valid copy. */
	fallbackErrors: ConfigError[] | undefined;
	overrides: Overrides;
	/** Provider ids that pool several accounts under one id; they only warn. */
	pooledProviders: string[];
	/** Accounts with configured auth now and no tag. */
	untagged: AccountKey[];
}

const NONE = "none";
const LABEL_WIDTH = 9;

/** The plain-text block of bare `/guard` (DESIGN.md section 11). */
export function statusText(input: StatusInput): string {
	const rows: Array<[label: string, value: string]> = [
		["Place", placeSummary(input)],
		["Account", accountValue(input)],
		["Overrides", overridesValue(input.overrides)],
		["Config", configValue(input)],
		["Zones", input.config.ok ? `${input.config.config.zones.join(", ")} (default: ${input.config.config.defaultZone})` : "unknown (config invalid)"],
		["Pooled", input.pooledProviders.length > 0 ? `pi-multiprovider: ${input.pooledProviders.join(", ")} (warns only)` : NONE],
		["Untagged", input.untagged.length > 0 ? input.untagged.map(describeAccount).join(", ") : NONE],
	];
	const lines = rows.flatMap(([label, value]) => {
		const [first, ...more] = value.split("\n");
		return [` ${label.padEnd(LABEL_WIDTH)} ${first}`, ...more.map((line) => ` ${" ".repeat(LABEL_WIDTH)} ${line}`)];
	});
	return ["guard status", ...lines, "", "(edit: /guard tag | place | zone ...)"].join("\n");
}

/** How a place rule reads in the status: its path, its remote, or both. */
export function ruleText(rule: PlaceRuleEntry): string {
	return [rule.path, rule.remote === undefined ? undefined : `remote ${rule.remote}`].filter((part) => part !== undefined).join(" + ");
}

/** The place line of the status: where, its zone and which rule or the default decides it. */
export function placeSummary({ place, config, cwd, home }: Pick<StatusInput, "place" | "config" | "cwd" | "home">): string {
	if (!place.ok) return `${displayPath(cwd, home)} -> unknown (${place.reason})`;
	const rule = place.ruleIndex === undefined || !config.ok ? undefined : config.config.places[place.ruleIndex];
	const decidedBy = place.ruleIndex === undefined || !rule ? "default zone" : `rule ${place.ruleIndex + 1}: ${ruleText(rule)}`;
	return `${displayPath(place.path, home)} -> ${place.zone} (${decidedBy})`;
}

function accountValue({ account, place, config }: StatusInput): string {
	if (!account) return "no model selected";
	const name = describeAccount(account);
	const zones = config.ok ? accountZones(config.config.accounts, account) : undefined;
	const decision = decide({ place, account, config });
	if (decision.verdict === "match") return `${name} -> ${zones?.join(", ")}  ✓ Match`;
	switch (decision.cause.kind) {
		case "zone-mismatch":
			return `${name} -> ${zones?.join(", ")}  ✗ no Match`;
		case "unknown-account":
			return `${name} -> unknown  ? Unknown (no zone tag)`;
		default:
			return `${name} -> ${zones ? zones.join(", ") : "unknown"}  ! cannot decide`;
	}
}

function overridesValue({ session, once }: Overrides): string {
	return `session: ${session ? `${describeAccount(session.account)} in ${session.zone}` : NONE}; allow-once: ${once ? describeAccount(once.account) : NONE}`;
}

function configValue({ config, fallbackErrors, home, configPath }: StatusInput): string {
	const path = displayPath(configPath, home);
	if (config.ok && !fallbackErrors) return `${path} (valid)`;
	const file = configPath.slice(configPath.lastIndexOf("/") + 1);
	const errors = fallbackErrors ?? (config.ok ? [] : config.errors);
	return [`${path} (invalid, ${config.ok ? "last valid copy in use" : "no valid copy, turns blocked"})`, ...formatConfigErrors(errors, file)].join("\n");
}
