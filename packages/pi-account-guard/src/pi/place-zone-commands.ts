import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigError, ConfigResult, GuardConfig, PlaceRuleEntry } from "../core/config.ts";
import type { ConfigWriter } from "../core/config-writer.ts";
import type { PlaceOutcome } from "../core/decide.ts";
import {
	parseNumber,
	parsePlaceAddArguments,
	PLACE_ADD_USAGE,
	PLACE_LIST_USAGE,
	PLACE_MOVE_USAGE,
	PLACE_REMOVE_USAGE,
	zoneNameProblem,
	ZONE_ADD_USAGE,
	ZONE_DEFAULT_USAGE,
	ZONE_REMOVE_USAGE,
	ZONE_RENAME_USAGE,
} from "../core/guard-command.ts";
import { addPlaceRule, movePlaceRule, placeChangeText, placeListText, placeZoneChanges, removePlaceRule, ruleLine } from "../core/place-edit.ts";
import { displayPath, type RemoteUrls } from "../core/place.ts";
import { normalizeRemoteUrl } from "../core/remote.ts";
import { placeSummary } from "../core/status.ts";
import { addZone, removeZone, renameZone, setDefaultZone, zoneReferences } from "../core/zone-edit.ts";

/** What the place and zone commands need from `/guard`: the shared helpers of its other commands, and the place. */
export interface PlaceZoneKit {
	home: string;
	writer: ConfigWriter | undefined;
	/** The real path, `undefined` when the path does not exist. */
	realpath(path: string): string | undefined;
	readRemoteUrls(cwd: string): RemoteUrls;
	/** The place zone this session decides with now: cached since the last `session_start` or edit. */
	currentPlace(ctx: ExtensionContext): PlaceOutcome;
	/** The place zone that rules `config` would give, resolved afresh. */
	placeUnder(ctx: ExtensionContext, config: GuardConfig): PlaceOutcome;
	/** Resolves this session's place zone again and draws the footer: the place zone follows an edit made through `/guard` at once. */
	reresolvePlace(ctx: ExtensionContext): void;
	fail(ctx: ExtensionContext, text: string): void;
	say(ctx: ExtensionContext, text: string): void;
	failWrite(ctx: ExtensionContext, action: string, errors: ConfigError[]): void;
	configForWrite(ctx: ExtensionContext, action: string): GuardConfig | undefined;
	/** The config the checks decide with, as `/guard` status reads it. */
	loadConfig(ctx: ExtensionContext): ConfigResult;
}

export interface PlaceZoneCommands {
	place(ctx: ExtensionContext, words: string[]): Promise<void>;
	zone(ctx: ExtensionContext, words: string[]): Promise<void>;
}

const THIS_DIRECTORY = "This directory and below";
const ONE_REMOTE = "One of its remotes";
const DIRECTORY_AND_REMOTE = "This directory and one of its remotes";

/** The `/guard place` and `/guard zone` commands (DESIGN.md section 11). */
export function createPlaceZoneCommands(kit: PlaceZoneKit): PlaceZoneCommands {
	const { writer, fail, say, failWrite, configForWrite } = kit;
	const usageOf = (usage: string) => `Usage: ${usage}`;

	/** The writer and the live config of an edit, or `undefined` after telling the user why there is none. */
	function editable(ctx: ExtensionContext, action: string): { writer: ConfigWriter; config: GuardConfig } | undefined {
		const config = configForWrite(ctx, action);
		if (!config) return undefined;
		if (!writer) return void fail(ctx, "guard: cannot write the config file here.");
		return { writer, config };
	}

	/** Applies `change` and, once written, makes this session use the new place zone at once. */
	function write(ctx: ExtensionContext, writing: ConfigWriter, change: (config: GuardConfig) => GuardConfig, action: string, done: string): void {
		const outcome = writing.update(change);
		if (!outcome.ok) return failWrite(ctx, action, outcome.errors);
		kit.reresolvePlace(ctx);
		say(ctx, done);
	}

	/** Whether the edit may go on: asks for a confirm only when it changes the zone of this place. */
	async function confirmedPlaceChange(ctx: ExtensionContext, proposed: GuardConfig, title: string, detail: string): Promise<boolean> {
		const before = kit.currentPlace(ctx);
		const after = kit.placeUnder(ctx, proposed);
		if (!placeZoneChanges(before, after)) return true;
		const sentence = placeChangeText(before, after);
		if (!ctx.hasUI) {
			fail(ctx, `guard: this edit changes the zone of this place. ${sentence} It needs a confirm, so use a UI.`);
			return false;
		}
		return ctx.ui.confirm(title, `${detail}\n${sentence}`);
	}

	async function pickZone(ctx: ExtensionContext, question: string, zones: string[]): Promise<string | undefined> {
		return ctx.ui.select(question, zones);
	}

	/** The index (0-based) of the rule the arguments or a picker name; `undefined` after a failure or a cancel. */
	async function chooseRule(ctx: ExtensionContext, config: GuardConfig, text: string | undefined, usage: string): Promise<number | undefined> {
		const count = config.places.length;
		if (text !== undefined) {
			const number = parseNumber(text, count);
			if (number === undefined) return void fail(ctx, `guard: ${text} is not a rule number; there ${count === 1 ? "is 1 rule" : `are ${count} rules`}.\n${usageOf(usage)}`);
			return number - 1;
		}
		if (!ctx.hasUI) return void fail(ctx, `guard: name the rule number.\n${usageOf(usage)}`);
		if (count === 0) return void fail(ctx, "guard: there are no place rules.");
		const labels = config.places.map((rule, index) => `${index + 1}. ${ruleLine(rule)}`);
		const answer = await ctx.ui.select("Which rule?", labels);
		const index = labels.indexOf(answer ?? "");
		return index < 0 ? undefined : index;
	}

	/** The conditions the dialogs offer, taken from this place: the directory, one of its remotes, or both. */
	async function askConditions(ctx: ExtensionContext, config: GuardConfig): Promise<Pick<PlaceRuleEntry, "path" | "remote"> | undefined> {
		const real = kit.realpath(ctx.cwd);
		if (real === undefined) return void fail(ctx, `guard: cannot resolve the real path of ${ctx.cwd}.`);
		const directory = displayPath(real, kit.home);
		const remotes = kit.readRemoteUrls(ctx.cwd);
		const urls = remotes.ok ? [...new Set(remotes.urls.map(normalizeRemoteUrl))] : [];
		const decides = placeSummary({ place: kit.currentPlace(ctx), config: { ok: true, config }, cwd: ctx.cwd, home: kit.home });
		const title = [decides, ...(remotes.ok ? [] : [`Its remotes cannot be read: ${remotes.reason}.`]), "What should the new rule match?"].join("\n");
		const options = [`${THIS_DIRECTORY} (${directory})`, ...(urls.length > 0 ? [ONE_REMOTE, DIRECTORY_AND_REMOTE] : [])];
		const choice = await ctx.ui.select(title, options);
		if (choice === undefined) return undefined;
		const withDirectory = choice !== ONE_REMOTE;
		if (choice === options[0]) return { path: directory };
		const remote = await ctx.ui.select("Which remote?", urls);
		if (remote === undefined) return undefined;
		return { ...(withDirectory ? { path: directory } : {}), remote };
	}

	async function placeAdd(ctx: ExtensionContext, words: string[]): Promise<void> {
		const named = parsePlaceAddArguments(words);
		if (!named) return fail(ctx, `guard: the arguments are not path=, remote=, zone= and at=, each once.\n${usageOf(PLACE_ADD_USAGE)}`);
		const edit = editable(ctx, "did not add the rule.");
		if (!edit) return;
		const { config } = edit;
		const count = config.places.length;
		const position = named.at === undefined ? 1 : parseNumber(named.at, count + 1);
		if (position === undefined) return fail(ctx, `guard: ${named.at} is not a position from 1 to ${count + 1}.\n${usageOf(PLACE_ADD_USAGE)}`);
		if (named.zone !== undefined && !config.zones.includes(named.zone)) return fail(ctx, `guard: did not add the rule. Not a declared zone: ${named.zone}. Declared zones: ${config.zones.join(", ")}.\n${usageOf(PLACE_ADD_USAGE)}`);
		let { path, remote } = named;
		if (path === "here") {
			const real = kit.realpath(ctx.cwd);
			if (real === undefined) return fail(ctx, `guard: cannot resolve the real path of ${ctx.cwd}.`);
			path = displayPath(real, kit.home);
		}
		if (path === undefined && remote === undefined) {
			if (!ctx.hasUI) return fail(ctx, `guard: name a condition.\n${usageOf(PLACE_ADD_USAGE)}`);
			const conditions = await askConditions(ctx, config);
			if (!conditions) return;
			({ path, remote } = conditions);
		}
		let zone = named.zone;
		if (zone === undefined) {
			if (!ctx.hasUI) return fail(ctx, `guard: name the zone.\n${usageOf(PLACE_ADD_USAGE)}`);
			if (config.zones.length === 0) return fail(ctx, "guard: no zone is declared; run /guard zone add first.");
			zone = await pickZone(ctx, "Which zone does the new rule give?", config.zones);
			if (zone === undefined) return;
		}
		const rule: PlaceRuleEntry = { ...(path === undefined ? {} : { path }), ...(remote === undefined ? {} : { remote }), zone };
		write(ctx, edit.writer, (current) => addPlaceRule(current, rule, position - 1), "did not add the rule.", `Added rule ${position}: ${ruleLine(rule)}.`);
	}

	function placeList(ctx: ExtensionContext, words: string[]): void {
		if (words.length > 0) return fail(ctx, `guard: too many arguments.\n${usageOf(PLACE_LIST_USAGE)}`);
		if (!ctx.hasUI) return;
		const config = kit.loadConfig(ctx);
		if (!config.ok) return failWrite(ctx, "cannot list the rules.", config.errors);
		ctx.ui.notify(placeListText(config.config, kit.currentPlace(ctx)), "info");
	}

	async function placeRemove(ctx: ExtensionContext, words: string[]): Promise<void> {
		if (words.length > 1) return fail(ctx, `guard: too many arguments.\n${usageOf(PLACE_REMOVE_USAGE)}`);
		const edit = editable(ctx, "did not remove the rule.");
		if (!edit) return;
		const index = await chooseRule(ctx, edit.config, words[0], PLACE_REMOVE_USAGE);
		if (index === undefined) return;
		const rule = edit.config.places[index]!;
		const proposed = removePlaceRule(edit.config, index);
		if (!(await confirmedPlaceChange(ctx, proposed, `Remove rule ${index + 1}?`, ruleLine(rule)))) return;
		write(ctx, edit.writer, (current) => removePlaceRule(current, index), "did not remove the rule.", `Removed rule ${index + 1} (${ruleLine(rule)}).`);
	}

	async function placeMove(ctx: ExtensionContext, words: string[]): Promise<void> {
		if (words.length === 1 || words.length > 2) return fail(ctx, `guard: name the rule and its new position.\n${usageOf(PLACE_MOVE_USAGE)}`);
		const edit = editable(ctx, "did not move the rule.");
		if (!edit) return;
		const count = edit.config.places.length;
		const from = await chooseRule(ctx, edit.config, words[0], PLACE_MOVE_USAGE);
		if (from === undefined) return;
		let toText = words[1];
		if (toText === undefined) {
			toText = await ctx.ui.input(`Move rule ${from + 1} to which position (1 to ${count})?`, "1");
			if (toText === undefined) return;
		}
		const to = parseNumber(toText.trim(), count);
		if (to === undefined) return fail(ctx, `guard: ${toText} is not a position from 1 to ${count}.\n${usageOf(PLACE_MOVE_USAGE)}`);
		if (to - 1 === from) return say(ctx, `Rule ${to} is already at position ${to}.`);
		const rule = edit.config.places[from]!;
		const proposed = movePlaceRule(edit.config, from, to - 1);
		if (!(await confirmedPlaceChange(ctx, proposed, `Move rule ${from + 1} to position ${to}?`, ruleLine(rule)))) return;
		write(ctx, edit.writer, (current) => movePlaceRule(current, from, to - 1), "did not move the rule.", `Moved rule ${from + 1} (${ruleLine(rule)}) to position ${to}.`);
	}

	async function zoneAdd(ctx: ExtensionContext, words: string[]): Promise<void> {
		if (words.length > 1) return fail(ctx, `guard: too many arguments.\n${usageOf(ZONE_ADD_USAGE)}`);
		const edit = editable(ctx, "did not add the zone.");
		if (!edit) return;
		let name = words[0];
		if (name === undefined) {
			if (!ctx.hasUI) return fail(ctx, `guard: name the zone.\n${usageOf(ZONE_ADD_USAGE)}`);
			name = (await ctx.ui.input("Name of the new zone?"))?.trim();
			if (!name) return;
		}
		const problem = zoneNameProblem(name);
		if (problem) return fail(ctx, `guard: did not add the zone. ${problem}`);
		if (edit.config.zones.includes(name)) return say(ctx, `Zone ${name} is already declared.`);
		write(ctx, edit.writer, (current) => addZone(current, name), `did not add zone ${name}.`, `Added zone ${name}.`);
	}

	/** The declared zone the arguments or a picker name; `undefined` after a failure or a cancel. */
	async function chooseZone(ctx: ExtensionContext, config: GuardConfig, name: string | undefined, question: string, usage: string): Promise<string | undefined> {
		if (name !== undefined) {
			if (config.zones.includes(name)) return name;
			return void fail(ctx, `guard: ${name} is not a declared zone. Declared zones: ${config.zones.join(", ")}.\n${usageOf(usage)}`);
		}
		if (!ctx.hasUI) return void fail(ctx, `guard: name the zone.\n${usageOf(usage)}`);
		if (config.zones.length === 0) return void fail(ctx, "guard: no zone is declared.");
		return pickZone(ctx, question, config.zones);
	}

	async function zoneRemove(ctx: ExtensionContext, words: string[]): Promise<void> {
		if (words.length > 1) return fail(ctx, `guard: too many arguments.\n${usageOf(ZONE_REMOVE_USAGE)}`);
		const edit = editable(ctx, "did not remove the zone.");
		if (!edit) return;
		const zone = await chooseZone(ctx, edit.config, words[0], "Which zone do you remove?", ZONE_REMOVE_USAGE);
		if (zone === undefined) return;
		const references = zoneReferences(edit.config, zone);
		if (references.length > 0) return fail(ctx, [`guard: did not remove zone ${zone}. It is still referenced by:`, ...references.map((reference) => `  ${reference}`)].join("\n"));
		write(ctx, edit.writer, (current) => removeZone(current, zone), `did not remove zone ${zone}.`, `Removed zone ${zone}.`);
	}

	async function zoneRename(ctx: ExtensionContext, words: string[]): Promise<void> {
		if (words.length === 1 || words.length > 2) return fail(ctx, `guard: name the zone and its new name.\n${usageOf(ZONE_RENAME_USAGE)}`);
		const edit = editable(ctx, "did not rename the zone.");
		if (!edit) return;
		const oldName = await chooseZone(ctx, edit.config, words[0], "Which zone do you rename?", ZONE_RENAME_USAGE);
		if (oldName === undefined) return;
		let newName = words[1];
		if (newName === undefined) {
			newName = (await ctx.ui.input(`New name of zone ${oldName}?`, oldName))?.trim();
			if (!newName) return;
		}
		const problem = zoneNameProblem(newName);
		if (problem) return fail(ctx, `guard: did not rename zone ${oldName}. ${problem}`);
		if (newName === oldName) return say(ctx, `Zone ${oldName} already has that name.`);
		if (edit.config.zones.includes(newName)) return fail(ctx, `guard: did not rename zone ${oldName}. Zone ${newName} is already declared.`);
		write(ctx, edit.writer, (current) => renameZone(current, oldName, newName), `did not rename zone ${oldName}.`, `Renamed zone ${oldName} to ${newName}.`);
	}

	async function zoneDefault(ctx: ExtensionContext, words: string[]): Promise<void> {
		if (words.length > 1) return fail(ctx, `guard: too many arguments.\n${usageOf(ZONE_DEFAULT_USAGE)}`);
		const edit = editable(ctx, "did not change the default zone.");
		if (!edit) return;
		const zone = await chooseZone(ctx, edit.config, words[0], "Which zone is the default?", ZONE_DEFAULT_USAGE);
		if (zone === undefined) return;
		if (zone === edit.config.defaultZone) return say(ctx, `The default zone is already ${zone}.`);
		if (!(await confirmedPlaceChange(ctx, setDefaultZone(edit.config, zone), `Change the default zone to ${zone}?`, `It is ${edit.config.defaultZone} now.`))) return;
		write(ctx, edit.writer, (current) => setDefaultZone(current, zone), "did not change the default zone.", `The default zone is ${zone}.`);
	}

	return {
		async place(ctx, [command, ...words]) {
			switch (command) {
				case "add":
					return placeAdd(ctx, words);
				case "list":
					return placeList(ctx, words);
				case "remove":
					return placeRemove(ctx, words);
				case "move":
					return placeMove(ctx, words);
				default:
					return fail(ctx, `guard: place needs add, list, remove or move.\n${usageOf(PLACE_ADD_USAGE)}`);
			}
		},
		async zone(ctx, [command, ...words]) {
			switch (command) {
				case "add":
					return zoneAdd(ctx, words);
				case "remove":
					return zoneRemove(ctx, words);
				case "rename":
					return zoneRename(ctx, words);
				case "default":
					return zoneDefault(ctx, words);
				default:
					return fail(ctx, `guard: zone needs add, remove, rename or default.\n${usageOf(ZONE_ADD_USAGE)}`);
			}
		},
	};
}
