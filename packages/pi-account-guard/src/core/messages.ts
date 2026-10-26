import { type AccountKey, describeAccount } from "./account.ts";
import { type ConfigError, formatConfigErrors } from "./config.ts";
import type { BlockCause, PlaceOutcome } from "./decide.ts";
import { displayPath, fileName } from "./paths.ts";
import { PROCESS_OVERRIDE_VARIABLE } from "./process-override.ts";

export interface MessageContext {
	home: string;
	/** Absolute path of the config file. */
	configPath: string;
}

/** The stderr text of a headless Block (DESIGN.md section 9.3); ends with a newline. */
export function headlessBlockMessage(cause: BlockCause, context: MessageContext): string {
	return `${headlessLines(cause, context).join("\n")}\n`;
}

function headlessLines(cause: BlockCause, context: MessageContext): string[] {
	const configFile = displayPath(context.configPath, context.home);
	switch (cause.kind) {
		case "zone-mismatch": {
			const { account, accountZones, place } = cause;
			return [
				`BLOCKED ${describeAccount(account)} is ${zonePhrase(accountZones)}; this place`,
				`(${displayPath(place.path, context.home)}) is zone ${place.zone}. No turn was sent.`,
				"",
				"Fix, any one of:",
				`  pi --model <an account in zone ${place.zone}>`,
				`  add a place rule if this directory belongs to zone ${accountZones.join(" or ")}`,
				`    in ${configFile}`,
			];
		}
		case "unknown-account": {
			const { account, place } = cause;
			const tag = JSON.stringify({ provider: account.provider, source: account.source, zones: [place.zone] });
			return [
				`BLOCKED ${describeAccount(account)} has no zone tag; place zone is ${place.zone}.`,
				`Add to ${configFile} accounts:`,
				`  ${tag}`,
				`or run pi, then: /guard tag ${account.provider} ${account.source} ${place.zone}`,
				`or set ${PROCESS_OVERRIDE_VARIABLE}=1 for this process.`,
			];
		}
		case "config-invalid":
			return [
				`BLOCKED ${describeAccount(cause.account)}: cannot read ${configFile}. No turn was sent.`,
				...formatConfigErrors(cause.errors, fileName(context.configPath)).map((line) => `  ${line}`),
				"Fix the file, then run pi again.",
			];
		case "place-undecidable":
			return [`BLOCKED ${describeAccount(cause.account)}: cannot decide this place's zone (${cause.reason}). No turn was sent.`];
		case "internal-error":
			return [`BLOCKED: the guard failed (${cause.reason}). No turn was sent.`];
	}
}

/** Where a turn runs, in words: the place zone and path, or that the zone is unknown. */
export function placeWhere(place: PlaceOutcome, context: MessageContext): string {
	return place.ok ? `a ${place.zone} place (${displayPath(place.path, context.home)})` : "a place whose zone is unknown";
}

export function zonePhrase(zones: string[]): string {
	return `${zones.length === 1 ? "zone" : "zones"} ${zones.join(", ")}`;
}

/** The warning shown once when a malformed config falls back to the last valid copy (DESIGN.md section 7). */
export function configFallbackWarning(errors: ConfigError[], context: MessageContext): string {
	const configFile = displayPath(context.configPath, context.home);
	return [
		`guard: cannot read ${configFile}; using the last valid copy for this session.`,
		...formatConfigErrors(errors, fileName(context.configPath)).map((line) => `  ${line}`),
		"The guard does not write to the file until it is fixed.",
	].join("\n");
}

/** The notice shown when one of the guard's own handlers throws. */
export function handlerErrorNotice(handler: string, reason: string): string {
	return `guard: the ${handler} handler failed (${reason}).`;
}

/** The warning shown once per session when the process Override lets a turn through (DESIGN.md section 10). */
export function processOverrideWarning(account: AccountKey): string {
	return `guard: ${PROCESS_OVERRIDE_VARIABLE}=1 lets turns through to accounts with no zone tag, starting with ${describeAccount(account)}. Each turn is logged in the session.`;
}
