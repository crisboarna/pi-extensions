import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LibraryFile, readLibraryEntries, updateLibraryFile } from "../core/config-writer.ts";
import { projectRefProblem } from "../core/confine.ts";
import { type Ref, validateRef } from "../core/library.ts";
import { foldName } from "../core/names.ts";
import { type Field, KINDS, libraryProblem, parseRefArguments, type RefCommand, splitWords } from "../core/ref-command.ts";
import { completeArguments } from "../core/ref-completions.ts";
import { applyFields, buildRef, jsonOf } from "../core/ref-edit.ts";
import { describeRef, formatList, readSettings, settingsProblems } from "../core/ref-list.ts";
import { addedConsequence, findPlaced, removalConsequence } from "../core/ref-relations.ts";
import {
	type CommandDeps,
	createRun,
	currentLayers,
	entryNames,
	globalLibraryFile,
	hereScope,
	isEntry,
	type Level,
	libraryFiles,
	message,
	type Run,
	readListed,
	type Target,
	targetOf,
	targetProblem,
	visibleLibrary,
} from "./ref-run.ts";
import { showSent } from "./sent.ts";

export type { CommandDeps } from "./ref-run.ts";

type Json = Record<string, unknown>;

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
	const readQuietly = (): string | undefined => {
		try {
			return deps.readText(deps.libraryPath);
		} catch {
			return undefined;
		}
	};
	// The Trigger is read when pi starts a session and never changes under the user, so /ref can say when the file now disagrees.
	// Trust is fixed at the start too, so completions know whether the Project library may be read.
	let sessionTrigger = readSettings(undefined).trigger;
	let project: { file: LibraryFile } | undefined;
	pi.on("session_start", (_event, ctx) => {
		sessionTrigger = readSettings(readQuietly()).trigger;
		project = ctx.isProjectTrusted() ? { file: libraryFiles(deps, ctx.cwd).project } : undefined;
	});

	pi.registerCommand("ref", {
		description: "List, add, edit and remove context Refs",
		getArgumentCompletions: (typed) => {
			const names = [...entryNames(globalLibraryFile(deps)), ...(project ? entryNames(project.file) : [])];
			return completeArguments(typed, [...new Set(names)]);
		},
		handler: async (args, ctx) => {
			const say = (text: string, level: Level = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(text, level);
				else deps.writeStderr(`${text}\n`);
			};
			const run = createRun(ctx, deps, say);
			const parsed = parseRefArguments(args);
			if (!parsed.ok) return say(parsed.usage === undefined ? parsed.error : `${parsed.error}\n${parsed.usage}`, "error");
			const unknownLibrary = libraryProblem(parsed.command);
			if (unknownLibrary !== undefined) return say(unknownLibrary, "error");
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
	const global = readListed(run.files.global);
	const project = run.trusted
		? readListed(run.files.project, (ref) => projectRefProblem(ref, run.place)).listed
		: { file: run.files.project.path, untrusted: true as const };
	run.say(
		formatList({
			...global.listed,
			warnings: [...global.listed.warnings, ...settingsProblems(global.text)],
			settings: readSettings(global.text),
			sessionTrigger,
			project,
			place: run.place,
			filter: {
				...(command.tag !== undefined && { tag: command.tag }),
				...(command.library !== undefined && { library: command.library as "global" | "project" }),
			},
		}),
	);
}

const TARGET_HINT: Record<string, string> = {
	path: "Path",
	file: "File path",
	snippet: "Snippet text",
	dynamic: "URL, or command with arguments",
};

/** The library a command works on: the one `in=` names, else `fallback`. */
function chooseTarget(run: Run, library: string | undefined, fallback: "global" | "project"): Target | undefined {
	const target = targetOf(run, library ?? fallback);
	if ("error" in target) {
		run.say(target.error, "error");
		return undefined;
	}
	return target;
}

async function add(run: Run, command: Extract<RefCommand, { name: "add" }>): Promise<void> {
	const { ctx } = run;
	let { refName, kind, target: words } = command;
	const target = chooseTarget(run, command.library, "global");
	if (!target) return;
	if (refName === undefined || kind === undefined || words.length === 0) {
		if (!ctx.hasUI) return run.say("a name, a kind and a target are needed when there is no UI\n/ref add <name> <kind> <target…>", "error");
		refName ??= await ctx.ui.input("Name of the new Ref", "letters, digits, . - _");
		if (!refName) return run.say("Cancelled; nothing was saved");
		kind ??= await ctx.ui.select("Kind", KINDS);
		if (!kind) return run.say("Cancelled; nothing was saved");
		if (words.length === 0) {
			const answer = await ctx.ui.input(TARGET_HINT[kind] ?? "Target", "");
			if (!answer) return run.say("Cancelled; nothing was saved");
			const split = splitWords(answer);
			words = kind === "dynamic" && "words" in split ? split.words.map((word) => word.text) : [answer];
		}
	}
	const built = buildRef({ refName, kind, target: words, fields: withScope(run, target, command.fields) });
	if (!built.ok) return run.say(built.error, "error");
	const problem = targetProblem(run, target, built.ref);
	if (problem) return run.say(problem, "error");
	const result = updateLibraryFile(target.file, (entries) => {
		const clash = findEntry(entries, built.ref.name);
		if (clash) return { error: `"${built.ref.name}" is already in ${target.phrase} as "${clash.name}"; change it with /ref edit ${clash.name}` };
		return { refs: [...entries, built.ref] };
	});
	if (!result.ok) return run.say(result.error, "error");
	run.say(
		`Added ${built.ref.kind} Ref "${built.ref.name}" to ${target.phrase}${scopeText(built.ref.scope)}${addedConsequence(currentLayers(run), target.library, built.ref.name)}`,
	);
}

/** The fields to set: `in=here` scopes the Ref to this repository first, unless the line sets a scope of its own. */
function withScope(run: Run, target: Target, fields: Field[]): Field[] {
	if (!target.here || fields.some((field) => field.key.startsWith("scope."))) return fields;
	const scope = hereScope(run);
	return [{ key: "scope.path", value: "" }, { key: "scope.remote", value: "" }, { key: scope.key, value: scope.value }, ...fields];
}

function scopeText(scope: { path?: string; remote?: string } | undefined): string {
	if (!scope) return "";
	const parts = [scope.remote === undefined ? undefined : `remote ${scope.remote}`, scope.path === undefined ? undefined : `directory ${scope.path}`];
	return `, scoped to ${parts.filter((part) => part !== undefined).join(" and ")}`;
}

/** The name to work on: the one typed, or one picked from the library when there is a UI. */
async function chooseName(run: Run, target: Target, typed: string | undefined, question: string, usage: string): Promise<string | undefined> {
	if (typed !== undefined) return typed;
	if (!run.ctx.hasUI) {
		run.say(`a name is needed when there is no UI\n${usage}`, "error");
		return undefined;
	}
	const entries = readLibraryEntries(target.file);
	if (!entries.ok) {
		run.say(entries.error, "error");
		return undefined;
	}
	const names = entries.entries.flatMap((entry) => (isEntry(entry) && typeof entry.name === "string" ? [entry.name] : []));
	const chosen = await run.ctx.ui.select(question, names);
	if (chosen === undefined) run.say("Cancelled");
	return chosen;
}

const noRef = (name: string, target: Target): string => `no Ref named "${name}" in ${target.phrase}`;

/** The library an edit or removal works on: the one `in=` names, else where the Visible Ref of that name lives, else the Global library. */
function chooseTargetFor(run: Run, command: { refName?: string; library?: string }): Target | undefined {
	return chooseTarget(run, command.library, command.refName === undefined || !run.trusted ? "global" : visibleLibrary(run, command.refName));
}

async function edit(run: Run, command: Extract<RefCommand, { name: "edit" }>): Promise<void> {
	if (command.refName === undefined && command.fields.length > 0)
		return run.say("a name is needed before key=value\n/ref edit <name> [key=value…] [in=<library>]", "error");
	const target = chooseTargetFor(run, command);
	if (!target) return;
	const name = await chooseName(run, target, command.refName, "Edit which Ref?", "/ref edit <name> [key=value…] [in=<library>]");
	if (name === undefined) return;
	const entries = readLibraryEntries(target.file);
	if (!entries.ok) return run.say(entries.error, "error");
	const found = findEntry(entries.entries, name);
	if (!found) return run.say(noRef(name, target), "error");
	const fields = withScope(run, target, command.fields);
	if (fields.length > 0) {
		const changed = applyFields(found.entry, fields);
		if (!changed.ok) return run.say(changed.error, "error");
		const saved = replaceRef(run, target, found.name, changed.ref);
		return run.say(saved.ok ? editedText(run, target, found.name, changed.ref) : saved.error, saved.ok ? "info" : "error");
	}
	if (!run.ctx.hasUI) return run.say("key=value is needed when there is no UI\n/ref edit <name> [key=value…] [in=<library>]", "error");
	await editInEditor(run, target, found);
}

const editedText = (run: Run, target: Target, before: string, ref: { name: string; kind: string }): string =>
	`${before === ref.name ? `Edited ${ref.kind} Ref "${ref.name}"` : `Renamed "${before}" to "${ref.name}"`}${addedConsequence(currentLayers(run), target.library, ref.name)}`;

/** Replaces the Ref called `name` with `ref`, re-reading the file first. `retry` is true when the person can fix it by editing again. */
function replaceRef(run: Run, target: Target, name: string, ref: Ref): { ok: true } | { ok: false; error: string; retry: boolean } {
	const problem = targetProblem(run, target, ref);
	if (problem) return { ok: false, error: problem, retry: true };
	let retry = false;
	const result = updateLibraryFile(target.file, (entries) => {
		const found = findEntry(entries, name);
		if (!found) return { error: noRef(name, target) };
		const clash = findEntry(
			entries.filter((_entry, index) => index !== found.index),
			ref.name,
		);
		if (clash) {
			retry = true;
			return { error: `"${ref.name}" is already in ${target.phrase} as "${clash.name}"; edit that one instead` };
		}
		return { refs: entries.map((entry, index) => (index === found.index ? ref : entry)) };
	});
	return result.ok ? result : { ok: false, error: result.error, retry };
}

/** Shows the Ref as JSON and saves what comes back. An invalid result opens the editor again with the error in its title. */
async function editInEditor(run: Run, target: Target, found: { entry: Json; name: string }): Promise<void> {
	const original = jsonOf(found.entry);
	let draft = original;
	let title = `Edit "${found.name}"`;
	for (;;) {
		const edited = await run.ctx.ui.editor(title, draft);
		if (edited === undefined) return run.say("Cancelled; nothing was changed");
		if (edited.trim() === original) return run.say(`Nothing changed in "${found.name}"`);
		draft = edited;
		const problem = trySave(run, target, found.name, edited);
		if (problem === undefined) return;
		if (!problem.retry) return run.say(problem.error, "error");
		title = `Edit "${found.name}": ${problem.error}`;
	}
}

/** Parses, validates and saves the edited text. Returns the problem, or undefined once saved (and reported). */
function trySave(run: Run, target: Target, name: string, edited: string): { error: string; retry: boolean } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(edited);
	} catch (error) {
		return { error: `the text is not valid JSON (${message(error)})`, retry: true };
	}
	const checked = validateRef(value, "ref");
	if (!("ref" in checked)) return { error: checked.problems.join("; "), retry: true };
	const saved = replaceRef(run, target, name, checked.ref);
	if (!saved.ok) return saved;
	run.say(editedText(run, target, name, checked.ref));
	return undefined;
}

async function remove(run: Run, command: Extract<RefCommand, { name: "remove" }>): Promise<void> {
	const target = chooseTargetFor(run, command);
	if (!target) return;
	const name = await chooseName(run, target, command.refName, "Remove which Ref?", "/ref remove <name> [in=<library>]");
	if (name === undefined) return;
	const entries = readLibraryEntries(target.file);
	if (!entries.ok) return run.say(entries.error, "error");
	const found = findEntry(entries.entries, name);
	if (!found) return run.say(noRef(name, target), "error");
	if (run.ctx.hasUI && !(await run.ctx.ui.confirm(`Remove "${found.name}"?`, removalText(run, target, found)))) return run.say(`Kept "${found.name}"`);
	const result = updateLibraryFile(target.file, (current) => {
		const again = findEntry(current, found.name);
		return again ? { refs: current.filter((_entry, index) => index !== again.index) } : { error: noRef(found.name, target) };
	});
	run.say(result.ok ? `Removed "${found.name}" from ${target.phrase}` : result.error, result.ok ? "info" : "error");
}

/** What the person loses: the kind, the library and the target, then any Ref the removed one was shadowing. A Snippet's text is kept nowhere else. */
function removalText(run: Run, target: Target, found: { entry: Json; name: string }): string {
	const checked = validateRef(found.entry, "ref");
	const lines = !("ref" in checked)
		? [`This entry is not a valid Ref (${checked.problems[0] ?? "unknown problem"}).`, `It is in ${target.phrase} (${target.file.path}).`]
		: [`${checked.ref.kind} Ref in ${target.phrase} (${target.file.path})`, describeRef(checked.ref)];
	if ("ref" in checked && checked.ref.kind === "snippet") lines.push("The text is lost for good.");
	const layered = currentLayers(run);
	const placed = findPlaced(layered, target.library, found.name);
	const consequence = placed ? removalConsequence(layered, placed) : "";
	return consequence === "" ? lines.join("\n") : [...lines, consequence].join("\n");
}
