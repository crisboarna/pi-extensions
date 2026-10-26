import { describeAccount } from "./account.ts";
import { formatConfigErrors } from "./config.ts";
import type { BlockCause } from "./decide.ts";
import { displayPath } from "./place.ts";

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

function zonePhrase(zones: string[]): string {
	return `${zones.length === 1 ? "zone" : "zones"} ${zones.join(", ")}`;
}

function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
