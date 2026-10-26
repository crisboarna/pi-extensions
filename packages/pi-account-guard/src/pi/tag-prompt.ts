import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeAccount, type AccountKey } from "../core/account.ts";
import { formatConfigErrors, type GuardConfig } from "../core/config.ts";
import { setAccountZones, type ConfigWriter } from "../core/config-writer.ts";
import { bypassNudge, parseZoneList, SEVERAL_ZONES_OPTION, tagPromptTitle } from "../core/tag-prompt.ts";
import { askZonesWithChecklist } from "./tag-checklist.ts";

export interface TagPrompt {
	ctx: ExtensionContext;
	account: AccountKey;
	/** The zone of the place the Block happened in. */
	placeZone: string;
	/** The live config; its declared zones are the choices. */
	config: GuardConfig;
	multiPassLabel: string | undefined;
	writer: ConfigWriter;
	/** The config file name, for error text. */
	configFile: string;
}

/** Asks which zones the Unknown account belongs to and writes the tag. Resolves with the zones written, or `undefined` when the user cancelled or the write was refused. */
export async function runTagPrompt({ ctx, account, placeZone, config, multiPassLabel, writer, configFile }: TagPrompt): Promise<string[] | undefined> {
	const declared = config.zones;
	if (declared.length === 0) return undefined;
	const title = tagPromptTitle(account, placeZone, multiPassLabel);
	for (;;) {
		const zones = await askZones(ctx, title, declared);
		if (zones === undefined) return undefined;
		const nudge = bypassNudge({ account, multiPassLabel, chosen: zones, declared });
		if (nudge && !(await ctx.ui.confirm(nudge.title, nudge.message))) continue;
		const outcome = writer.update((current) => setAccountZones(current, account, zones));
		if (!outcome.ok) {
			ctx.ui.notify([`guard: did not tag ${describeAccount(account)}.`, ...formatConfigErrors(outcome.errors, configFile)].join("\n"), "error");
			return undefined;
		}
		ctx.ui.notify(`Tagged ${describeAccount(account)} as ${zones.join(", ")}.`, "info");
		return zones;
	}
}

/** The TUI draws a checkbox list; RPC cannot render custom components, so it gets a select of single zones and an input for several. */
async function askZones(ctx: ExtensionContext, title: string, declared: string[]): Promise<string[] | undefined> {
	if (ctx.mode === "tui") return askZonesWithChecklist(ctx, title, declared);
	const choice = await ctx.ui.select(title, [...declared, SEVERAL_ZONES_OPTION]);
	if (choice === undefined) return undefined;
	if (choice !== SEVERAL_ZONES_OPTION) return [choice];
	let question = title;
	for (;;) {
		const text = await ctx.ui.input(question, declared.join(", "));
		if (text === undefined) return undefined;
		const parsed = parseZoneList(text, declared);
		if (parsed.ok) return parsed.zones;
		question = `${parsed.message}\n${title}`;
	}
}
