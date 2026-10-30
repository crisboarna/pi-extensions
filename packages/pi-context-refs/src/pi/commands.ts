import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type LibraryFile, readLibraryEntries, updateLibraryFile } from "../core/config-writer.ts";
import { parseLibrary, validateRef } from "../core/library.ts";
import { foldName } from "../core/names.ts";
import { KINDS, LIBRARY_NAMES, parseRefArguments, type RefCommand, splitWords } from "../core/ref-command.ts";
import { completeArguments } from "../core/ref-completions.ts";
import { applyFields, buildRef, jsonOf } from "../core/ref-edit.ts";
import { describeRef, formatList, readSettings } from "../core/ref-list.ts";
import { showSent } from "./sent.ts";

/** What `/ref` needs from outside pi, so tests can stand in for the machine. */
export interface CommandDeps {
	/** The Global library file. */
	libraryPath: string;
	readText: (path: string) => string | undefined;
	/** Replaces the file atomically. */
	writeText: (path: string, text: string) => void;
	writeStderr: (text: string) => void;
}

type Json = Record<string, unknown>;
type Level = "info" | "error";

/** One run of `/ref`: where its output goes and which file it works on. */
interface Run {
	ctx: ExtensionCommandContext;
	file: LibraryFile;
	say(text: string, level?: Level): void;
}

const LIBRARY = "the Global library";

const isEntry = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first entry called `name` (names are case-insensitive), with its position. */
function findEntry(entries: readonly unknown[], name: string): { index: number; entry: Json; name: string } | undefined {
	const wanted = foldName(name);
	for (const [index, entry] of entries.entries()) {
		if (isEntry(entry) && typeof entry.name === "string" && foldName(entry.name) === wanted) return { index, entry, name: entry.name };
	}
	return undefined;
}

/** Registers `/ref` with its subcommands and their completions. */
export function registerRefCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	const file: LibraryFile = {
		path: deps.libraryPath,
		read: () => deps.readText(deps.libraryPath),
		write: (text) => deps.writeText(deps.libraryPath, text),
	};
	const readQuietly = (): string | undefined => {
		try {
			return file.read();
		} catch {
			return undefined;
		}
	};
	// The Trigger is read when pi starts a session and never changes under the user, so /ref can say when the file now disagrees.
	let sessionTrigger = readSettings(undefined).trigger;
	pi.on("session_start", () => {
		sessionTrigger = readSettings(readQuietly()).trigger;
	});

	pi.registerCommand("ref", {
		description: "List, add, edit and remove context Refs",
		getArgumentCompletions: (typed) => {
			const entries = readLibraryEntries(file);
			const names = entries.ok ? entries.entries.flatMap((entry) => (isEntry(entry) && typeof entry.name === "string" ? [entry.name] : [])) : [];
			return completeArguments(typed, names);
		},
		handler: async (args, ctx) => {
			const say = (text: string, level: Level = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(text, level);
				else deps.writeStderr(`${text}\n`);
			};
			const run: Run = { ctx, file, say };
			const parsed = parseRefArguments(args);
			if (!parsed.ok) return say(parsed.usage === undefined ? parsed.error : `${parsed.error}\n${parsed.usage}`, "error");
			if ("library" in parsed.command && parsed.command.library !== undefined && !LIBRARY_NAMES.includes(parsed.command.library)) {
				return say(`unknown library "${parsed.command.library}"; the libraries are: ${LIBRARY_NAMES.join(", ")}`, "error");
			}
			await dispatch(run, parsed.command, sessionTrigger);
		},
	});
}

async function dispatch(run: Run, command: RefCommand, sessionTrigger: string): Promise<void> {
	switch (command.name) {
		case "list":
			return list(run, command, sessionTrigger);
		case "add":
			return add(run, command);
		case "edit":
			return edit(run, command);
		case "remove":
			return remove(run, command);
		case "sent":
			return showSent(run.ctx, run.say);
	}
}

function list(run: Run, command: Extract<RefCommand, { name: "list" }>, sessionTrigger: string): void {
	let text: string | undefined;
	let unreadable: string | undefined;
	try {
		text = run.file.read();
	} catch (error) {
		unreadable = `${run.file.path} could not be read: ${message(error)}`;
	}
	const library = text === undefined ? undefined : parseLibrary(text, run.file.path);
	const base = { file: run.file.path, settings: readSettings(text), sessionTrigger, filter: command.tag === undefined ? {} : { tag: command.tag } };
	if (unreadable !== undefined) run.say(formatList({ ...base, refs: [], warnings: [], error: unreadable }));
	else if (library === undefined) run.say(formatList({ ...base, refs: [], warnings: [] }));
	else
		run.say(
			formatList(library.ok ? { ...base, refs: library.refs, warnings: library.warnings } : { ...base, refs: [], warnings: [], error: library.error }),
		);
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const TARGET_HINT: Record<string, string> = {
	path: "Path",
	file: "File path",
	snippet: "Snippet text",
	dynamic: "URL, or command with arguments",
};

async function add(run: Run, command: Extract<RefCommand, { name: "add" }>): Promise<void> {
	const { ctx } = run;
	let { refName, kind, target } = command;
	if (refName === undefined || kind === undefined || target.length === 0) {
		if (!ctx.hasUI) return run.say("a name, a kind and a target are needed when there is no UI\n/ref add <name> <kind> <target…>", "error");
		refName ??= await ctx.ui.input("Name of the new Ref", "letters, digits, . - _");
		if (!refName) return run.say("Cancelled; nothing was saved");
		kind ??= await ctx.ui.select("Kind", KINDS);
		if (!kind) return run.say("Cancelled; nothing was saved");
		if (target.length === 0) {
			const answer = await ctx.ui.input(TARGET_HINT[kind] ?? "Target", "");
			if (!answer) return run.say("Cancelled; nothing was saved");
			const words = splitWords(answer);
			target = kind === "dynamic" && "words" in words ? words.words.map((word) => word.text) : [answer];
		}
	}
	const built = buildRef({ refName, kind, target, fields: command.fields });
	if (!built.ok) return run.say(built.error, "error");
	const result = updateLibraryFile(run.file, (entries) => {
		const clash = findEntry(entries, built.ref.name);
		if (clash) return { error: `"${built.ref.name}" is already in ${LIBRARY} as "${clash.name}"; change it with /ref edit ${clash.name}` };
		return { refs: [...entries, built.ref] };
	});
	if (!result.ok) return run.say(result.error, "error");
	run.say(`Added ${built.ref.kind} Ref "${built.ref.name}" to ${LIBRARY}`);
}

/** The name to work on: the one typed, or one picked from the library when there is a UI. */
async function chooseName(run: Run, typed: string | undefined, question: string, usage: string): Promise<string | undefined> {
	if (typed !== undefined) return typed;
	if (!run.ctx.hasUI) {
		run.say(`a name is needed when there is no UI\n${usage}`, "error");
		return undefined;
	}
	const entries = readLibraryEntries(run.file);
	if (!entries.ok) {
		run.say(entries.error, "error");
		return undefined;
	}
	const names = entries.entries.flatMap((entry) => (isEntry(entry) && typeof entry.name === "string" ? [entry.name] : []));
	const chosen = await run.ctx.ui.select(question, names);
	if (chosen === undefined) run.say("Cancelled");
	return chosen;
}

const noRef = (name: string): string => `no Ref named "${name}" in ${LIBRARY}`;

async function edit(run: Run, command: Extract<RefCommand, { name: "edit" }>): Promise<void> {
	if (command.refName === undefined && command.fields.length > 0) return run.say("a name is needed before key=value\n/ref edit <name> [key=value…]", "error");
	const name = await chooseName(run, command.refName, "Edit which Ref?", "/ref edit <name> [key=value…]");
	if (name === undefined) return;
	const entries = readLibraryEntries(run.file);
	if (!entries.ok) return run.say(entries.error, "error");
	const found = findEntry(entries.entries, name);
	if (!found) return run.say(noRef(name), "error");
	if (command.fields.length > 0) {
		const changed = applyFields(found.entry, command.fields);
		if (!changed.ok) return run.say(changed.error, "error");
		const saved = replaceRef(run, found.name, changed.ref);
		return run.say(saved.ok ? editedText(found.name, changed.ref) : saved.error, saved.ok ? "info" : "error");
	}
	if (!run.ctx.hasUI) return run.say("key=value is needed when there is no UI\n/ref edit <name> [key=value…]", "error");
	await editInEditor(run, found);
}

const editedText = (before: string, ref: { name: string; kind: string }): string =>
	before === ref.name ? `Edited ${ref.kind} Ref "${ref.name}"` : `Renamed "${before}" to "${ref.name}"`;

/** Replaces the Ref called `name` with `ref`, re-reading the file first. `retry` is true when the person can fix it by editing again. */
function replaceRef(run: Run, name: string, ref: { name: string }): { ok: true } | { ok: false; error: string; retry: boolean } {
	let retry = false;
	const result = updateLibraryFile(run.file, (entries) => {
		const found = findEntry(entries, name);
		if (!found) return { error: noRef(name) };
		const clash = findEntry(
			entries.filter((_entry, index) => index !== found.index),
			ref.name,
		);
		if (clash) {
			retry = true;
			return { error: `"${ref.name}" is already in ${LIBRARY} as "${clash.name}"; edit that one instead` };
		}
		return { refs: entries.map((entry, index) => (index === found.index ? ref : entry)) };
	});
	return result.ok ? result : { ok: false, error: result.error, retry };
}

/** Shows the Ref as JSON and saves what comes back. An invalid result opens the editor again with the error in its title. */
async function editInEditor(run: Run, found: { entry: Json; name: string }): Promise<void> {
	const original = jsonOf(found.entry);
	let draft = original;
	let title = `Edit "${found.name}"`;
	for (;;) {
		const edited = await run.ctx.ui.editor(title, draft);
		if (edited === undefined) return run.say("Cancelled; nothing was changed");
		if (edited.trim() === original) return run.say(`Nothing changed in "${found.name}"`);
		draft = edited;
		const problem = await trySave(run, found.name, edited);
		if (problem === undefined) return;
		if (!problem.retry) return run.say(problem.error, "error");
		title = `Edit "${found.name}": ${problem.error}`;
	}
}

/** Parses, validates and saves the edited text. Returns the problem, or undefined once saved (and reported). */
function trySave(run: Run, name: string, edited: string): { error: string; retry: boolean } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(edited);
	} catch (error) {
		return { error: `the text is not valid JSON (${message(error)})`, retry: true };
	}
	const checked = validateRef(value, "ref");
	if (!("ref" in checked)) return { error: checked.problems.join("; "), retry: true };
	const saved = replaceRef(run, name, checked.ref);
	if (!saved.ok) return saved;
	run.say(editedText(name, checked.ref));
	return undefined;
}

async function remove(run: Run, command: Extract<RefCommand, { name: "remove" }>): Promise<void> {
	const name = await chooseName(run, command.refName, "Remove which Ref?", "/ref remove <name> [in=<library>]");
	if (name === undefined) return;
	const entries = readLibraryEntries(run.file);
	if (!entries.ok) return run.say(entries.error, "error");
	const found = findEntry(entries.entries, name);
	if (!found) return run.say(noRef(name), "error");
	if (run.ctx.hasUI && !(await run.ctx.ui.confirm(`Remove "${found.name}"?`, removalText(found.entry, run.file.path))))
		return run.say(`Kept "${found.name}"`);
	const result = updateLibraryFile(run.file, (current) => {
		const again = findEntry(current, found.name);
		return again ? { refs: current.filter((_entry, index) => index !== again.index) } : { error: noRef(found.name) };
	});
	run.say(result.ok ? `Removed "${found.name}" from ${LIBRARY}` : result.error, result.ok ? "info" : "error");
}

/** What the person loses: the kind, the library and the target. A Snippet's text is kept nowhere else. */
function removalText(entry: Json, path: string): string {
	const checked = validateRef(entry, "ref");
	if (!("ref" in checked)) return `This entry is not a valid Ref (${checked.problems[0] ?? "unknown problem"}).\nIt is in ${LIBRARY} (${path}).`;
	const lines = [`${checked.ref.kind} Ref in ${LIBRARY} (${path})`, describeRef(checked.ref)];
	if (checked.ref.kind === "snippet") lines.push("The text is lost for good.");
	return lines.join("\n");
}
