import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountKey, describeAccount } from "../core/account.ts";
import { accountZones, type ConfigError, formatConfigErrors, type GuardConfig } from "../core/config.ts";
import type { ConfigSnapshot, ConfigState } from "../core/config-state.ts";
import { type ConfigWriter, createConfigFileWriter, removeAccount, setAccountZones } from "../core/config-writer.ts";
import type { PlaceOutcome } from "../core/decide.ts";
import {
	type AccountArguments,
	GUARD_USAGE,
	parseTagArguments,
	parseUntagArguments,
	sameZones,
	TAG_USAGE,
	UNTAG_USAGE,
	zoneChangeText,
} from "../core/guard-command.ts";
import { type KnownAccount, knownAccountLabel, knownAccounts } from "../core/known-accounts.ts";
import type { MessageContext } from "../core/messages.ts";
import type { Overrides } from "../core/overrides.ts";
import { fileName } from "../core/paths.ts";
import type { RemoteUrls } from "../core/place.ts";
import { statusText } from "../core/status.ts";
import { accountInWords, parseZoneList } from "../core/tag-prompt.ts";
import type { AccountOfModel } from "./account-of.ts";
import { type FailHeadless, reportOnError } from "./handler-errors.ts";
import { offersOf } from "./interactive-block.ts";
import { createPlaceZoneCommands } from "./place-zone-commands.ts";
import { askZones } from "./tag-prompt.ts";

/** Exit code of a `/guard` command that failed without a UI. */
const COMMAND_FAILED_EXIT_CODE = 2;

export interface GuardCommandDeps extends MessageContext {
	configState: ConfigState;
	/** Replaces the file atomically; without it `tag` and `untag` fail. */
	writeConfigText?(path: string, text: string): void;
	/** The config the checks decide with, as `loadSnapshot` of the hooks reads it. */
	loadSnapshot(ctx: ExtensionContext): ConfigSnapshot;
	currentPlace(ctx: ExtensionContext, snapshot: ConfigSnapshot): PlaceOutcome;
	/** The place zone that `config` would give for the session cwd, resolved afresh with no cache. */
	placeUnder(ctx: ExtensionContext, config: GuardConfig): PlaceOutcome;
	/** Resolves the place zone again and draws the footer; called after an edit made through `/guard`. */
	reresolvePlace(ctx: ExtensionContext): void;
	/** The real path, `undefined` when the path does not exist. */
	realpath(path: string): string | undefined;
	readRemoteUrls(cwd: string): RemoteUrls;
	overrides(): Overrides;
	/** Provider ids that pool several accounts under one id. */
	pooledProviders?(ctx: ExtensionContext): string[];
	multiPassLabel?(provider: string): string | undefined;
	/** Draws the footer item again after a config change. */
	refreshFooter(ctx: ExtensionContext): void;
	writeStderr(text: string): void;
	setExitCode(code: number): void;
	/** Writes the text to stderr and sets the Block exit code; reports a handler that throws. */
	failHeadless: FailHeadless;
	accountOfModel: AccountOfModel;
}

/** Registers `/guard`: status, tag, untag, place and zone (DESIGN.md section 11). Every command takes full arguments; dialogs only fill in missing ones. */
export function registerGuardCommand(pi: ExtensionAPI, deps: GuardCommandDeps): void {
	const { configState, writeConfigText } = deps;
	const writer: ConfigWriter | undefined = createConfigFileWriter(configState, deps.configPath, writeConfigText);
	const configFile = fileName(deps.configPath);

	/** A failed command: the text goes to the UI, or to stderr with a non-zero exit code when there is none. */
	function fail(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) {
			ctx.ui.notify(text, "error");
			return;
		}
		deps.writeStderr(`${text}\n`);
		deps.setExitCode(COMMAND_FAILED_EXIT_CODE);
	}

	/** Success text; headless modes print nothing on success (DESIGN.md section 11). */
	function say(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) ctx.ui.notify(text, "info");
	}

	function failWrite(ctx: ExtensionContext, action: string, errors: ConfigError[]): void {
		fail(ctx, [`guard: ${action}`, ...formatConfigErrors(errors, configFile)].join("\n"));
	}

	function status(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const snapshot = deps.loadSnapshot(ctx);
		const tags = snapshot.result.ok ? snapshot.result.config.accounts : [];
		const known = knownAccounts(
			offersOf(ctx, deps.accountOfModel).map((offer) => offer.account),
			tags,
		);
		ctx.ui.notify(
			statusText({
				home: deps.home,
				configPath: deps.configPath,
				cwd: ctx.cwd,
				place: deps.currentPlace(ctx, snapshot),
				account: ctx.model ? deps.accountOfModel(ctx, ctx.model) : undefined,
				config: snapshot.result,
				fallbackErrors: snapshot.fallback?.errors,
				overrides: deps.overrides(),
				pooledProviders: deps.pooledProviders?.(ctx) ?? [],
				untagged: known.filter((account) => account.configured && account.zones === undefined).map((account) => account.key),
				missing: known.flatMap((account) => (!account.configured && account.zones ? [{ key: account.key, zones: account.zones }] : [])),
			}),
			"info",
		);
	}

	/** The live file, or `undefined` after telling the user why the guard cannot change it. */
	function configForWrite(ctx: ExtensionContext, action: string): GuardConfig | undefined {
		const live = configState.readForWrite();
		if (live.ok) return live.config;
		failWrite(ctx, `${action} The file is malformed, and the guard never writes over a malformed file.`, live.errors);
		return undefined;
	}

	function candidatesOf(ctx: ExtensionContext, config: GuardConfig): KnownAccount[] {
		return knownAccounts(
			offersOf(ctx, deps.accountOfModel).map((offer) => offer.account),
			config.accounts,
		);
	}

	/**
	 * The account the arguments name: the current model's account without arguments, the provider's current source without a source, a picker when that is ambiguous.
	 * `taggedOnly` limits the pickers to accounts with a tag. `undefined` after a failure or a cancel.
	 */
	async function chooseAccount(
		ctx: ExtensionContext,
		{ provider, source }: AccountArguments,
		candidates: KnownAccount[],
		usage: string,
		taggedOnly: boolean,
	): Promise<AccountKey | undefined> {
		if (provider !== undefined && source !== undefined) return { provider, source };
		const pick = async (all: KnownAccount[]): Promise<AccountKey | undefined> => {
			const tagged = all.filter((candidate) => candidate.zones !== undefined);
			const options = taggedOnly && tagged.length > 0 ? tagged : all;
			if (!ctx.hasUI) {
				fail(ctx, `guard: name the source, one of: ${options.map((option) => option.key.source).join(", ")}.\nUsage: ${usage}`);
				return undefined;
			}
			const labels = options.map(knownAccountLabel);
			const answer = await ctx.ui.select("Which account?", labels);
			return options[labels.indexOf(answer ?? "")]?.key;
		};
		if (provider === undefined) {
			if (ctx.model) return deps.accountOfModel(ctx, ctx.model);
			if (candidates.length === 0 || !ctx.hasUI) {
				fail(ctx, `guard: no model is selected and no account was named.\nUsage: ${usage}`);
				return undefined;
			}
			return pick(candidates);
		}
		const ofProvider = candidates.filter((candidate) => candidate.key.provider === provider);
		const configured = ofProvider.filter((candidate) => candidate.configured);
		const only = configured.length === 1 ? configured[0] : ofProvider.length === 1 ? ofProvider[0] : undefined;
		if (only) return only.key;
		if (ofProvider.length === 0) {
			fail(ctx, `guard: no account of provider ${provider} is configured or tagged; name its source.\nUsage: ${usage}`);
			return undefined;
		}
		return pick(ofProvider);
	}

	async function tag(ctx: ExtensionContext, words: string[]): Promise<void> {
		const config = configForWrite(ctx, "did not tag.");
		if (!config) return;
		if (!writer) return fail(ctx, "guard: cannot write the config file here.");
		const named = parseTagArguments(words, config.zones);
		const account = await chooseAccount(ctx, named, candidatesOf(ctx, config), TAG_USAGE, false);
		if (!account) return;
		const name = describeAccount(account);
		let zones: string[] | undefined;
		if (named.zonesText !== undefined) {
			const parsed = parseZoneList(named.zonesText, config.zones);
			if (!parsed.ok) return fail(ctx, `guard: did not tag ${name}. ${parsed.message}\nUsage: ${TAG_USAGE}`);
			zones = parsed.zones;
		} else if (ctx.hasUI) {
			zones = await askZones(ctx, `Which zones does ${accountInWords(account, deps.multiPassLabel?.(account.provider))} belong to?`, config.zones);
			if (!zones) return;
		} else {
			return fail(ctx, `guard: name the zones of ${name}.\nUsage: ${TAG_USAGE}`);
		}
		const existing = accountZones(config.accounts, account);
		if (existing && sameZones(existing, zones)) return say(ctx, `${name} is already tagged as ${zones.join(", ")}.`);
		if (existing) {
			if (!ctx.hasUI)
				return fail(ctx, `guard: ${name} is tagged ${existing.join(", ")}; changing it needs a confirm, so run /guard untag first or use a UI.`);
			if (!(await ctx.ui.confirm(`Change the zones of ${name}?`, zoneChangeText(existing, zones)))) return;
		}
		const outcome = writer.update((current) => setAccountZones(current, account, zones));
		if (!outcome.ok) return failWrite(ctx, `did not tag ${name}.`, outcome.errors);
		deps.refreshFooter(ctx);
		say(ctx, `Tagged ${name} as ${zones.join(", ")}.`);
	}

	async function untag(ctx: ExtensionContext, words: string[]): Promise<void> {
		const named = parseUntagArguments(words);
		if (!named) return fail(ctx, `guard: too many arguments.\nUsage: ${UNTAG_USAGE}`);
		const config = configForWrite(ctx, "did not untag.");
		if (!config) return;
		if (!writer) return fail(ctx, "guard: cannot write the config file here.");
		const account = await chooseAccount(ctx, named, candidatesOf(ctx, config), UNTAG_USAGE, true);
		if (!account) return;
		const name = describeAccount(account);
		const existing = accountZones(config.accounts, account);
		if (!existing) return say(ctx, `${name} has no zone tag.`);
		const outcome = writer.update((current) => removeAccount(current, account));
		if (!outcome.ok) return failWrite(ctx, `did not untag ${name}.`, outcome.errors);
		deps.refreshFooter(ctx);
		say(ctx, `Untagged ${name} (was ${existing.join(", ")}).`);
	}

	const placeZone = createPlaceZoneCommands({
		home: deps.home,
		writer,
		realpath: deps.realpath,
		readRemoteUrls: deps.readRemoteUrls,
		currentPlace: (ctx) => deps.currentPlace(ctx, deps.loadSnapshot(ctx)),
		placeUnder: deps.placeUnder,
		reresolvePlace: deps.reresolvePlace,
		fail,
		say,
		failWrite,
		configForWrite,
		loadConfig: (ctx) => deps.loadSnapshot(ctx).result,
	});

	pi.registerCommand("guard", {
		description: "Show the guard status, tag and untag accounts, edit place rules and zones",
		handler: reportOnError(pi, "/guard", deps.failHeadless, async (args: string, ctx) => {
			const [command, ...words] = args.split(/\s+/).filter((word) => word !== "");
			switch (command) {
				case undefined:
					return status(ctx);
				case "tag":
					return tag(ctx, words);
				case "untag":
					return untag(ctx, words);
				case "place":
					return placeZone.place(ctx, words);
				case "zone":
					return placeZone.zone(ctx, words);
				default:
					return fail(ctx, `guard: unknown command "${command}".\n${GUARD_USAGE}`);
			}
		}),
	});
}
