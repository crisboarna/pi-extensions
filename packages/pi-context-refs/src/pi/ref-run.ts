import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type LibraryFile, readLibraryEntries } from "../core/config-writer.ts";
import { projectRefProblem } from "../core/confine.ts";
import { parseLibrary, type Ref, type RefCheck } from "../core/library.ts";
import { foldName } from "../core/names.ts";
import { type ListedLibrary, UNTRUSTED } from "../core/ref-list.ts";
import { type LibraryName, libraryOf } from "../core/ref-relations.ts";
import { type LayeredRefs, resolveRefs } from "../core/resolve.ts";
import { normalizeRemote, type Place } from "../core/scope.ts";
import type { ApprovalDeps } from "./approvals.ts";
import { projectLibraryPath } from "./libraries.ts";

/** What `/ref` needs from outside pi, so tests can stand in for the machine. */
export interface CommandDeps extends ApprovalDeps {
	/** The Global library file. */
	libraryPath: string;
	home: string;
	writeStderr: (text: string) => void;
	/** The fetch URLs of the remotes of the repository that holds a directory, or undefined when git cannot tell. */
	readRemotes: (cwd: string) => string[] | undefined;
}

export type Level = "info" | "error";

/** One run of `/ref`: where its output goes, where the session is, and the two library files. */
export interface Run {
	ctx: ExtensionContext;
	deps: CommandDeps;
	say(text: string, level?: Level): void;
	place: Place;
	trusted: boolean;
	files: Record<LibraryName, LibraryFile>;
}

/** The library a command works on. */
export interface Target {
	library: LibraryName;
	file: LibraryFile;
	/** How messages name it: "the Global library". */
	phrase: string;
	/** True for `in=here`: the Ref is saved in the Global library, scoped to this repository. */
	here: boolean;
}

type Json = Record<string, unknown>;

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const isEntry = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The names of the entries of a library file, as they are on disk. */
export function entryNames(file: LibraryFile): string[] {
	const entries = readLibraryEntries(file);
	return entries.ok ? entries.entries.flatMap((entry) => (isEntry(entry) && typeof entry.name === "string" ? [entry.name] : [])) : [];
}

const PHRASE: Record<LibraryName, string> = { global: "the Global library", project: "the Project library" };

const libraryFile = (deps: CommandDeps, path: string): LibraryFile => ({ path, read: () => deps.readText(path), write: (text) => deps.writeText(path, text) });

export const globalLibraryFile = (deps: CommandDeps): LibraryFile => libraryFile(deps, deps.libraryPath);

/** The two library files for a session at `cwd`. */
export const libraryFiles = (deps: CommandDeps, cwd: string): Record<LibraryName, LibraryFile> => ({
	global: globalLibraryFile(deps),
	project: libraryFile(deps, projectLibraryPath(cwd)),
});

export function createRun(ctx: ExtensionContext, deps: CommandDeps, say: Run["say"]): Run {
	const place: Place = { cwd: ctx.cwd, home: deps.home, realpath: deps.realpath, remotes: () => deps.readRemotes(ctx.cwd) };
	return { ctx, deps, say, place, trusted: ctx.isProjectTrusted(), files: libraryFiles(deps, ctx.cwd) };
}

/** Why the Project library is not available in this session. */
export const untrustedText = (run: Run): string => `the Project library ${run.files.project.path} is not loaded. ${UNTRUSTED}`;

/** The library `in=` names (the Global library when it is `here`), or why it cannot be used. */
export function targetOf(run: Run, library: string): Target | { error: string } {
	if (library === "project" && !run.trusted) return { error: untrustedText(run) };
	const name: LibraryName = library === "project" ? "project" : "global";
	return { library: name, file: run.files[name], phrase: PHRASE[name], here: library === "here" };
}

/** What saving a Ref in a library must also satisfy: the Project library's rules. Returns the problem, or undefined. */
export function targetProblem(run: Run, target: Target, ref: Ref): string | undefined {
	if (target.library !== "project") return undefined;
	const problem = projectRefProblem(ref, run.place);
	return problem ? `ref.${problem.field}: ${problem.message}` : undefined;
}

/** A library file read for display and resolution: its Refs and warnings, or the reason it cannot be used. */
export function readListed(file: LibraryFile, refCheck?: RefCheck): { listed: ListedLibrary; text: string | undefined } {
	let text: string | undefined;
	try {
		text = file.read();
	} catch (error) {
		return { listed: { file: file.path, refs: [], warnings: [], error: `${file.path} could not be read: ${message(error)}` }, text };
	}
	if (text === undefined) return { listed: { file: file.path, refs: [], warnings: [] }, text };
	const parsed = parseLibrary(text, file.path, refCheck);
	return {
		listed: parsed.ok
			? { file: file.path, refs: parsed.refs, warnings: parsed.warnings }
			: { file: file.path, refs: [], warnings: [], error: parsed.error },
		text,
	};
}

/** Both libraries as they are on disk right now, with precedence applied. */
export function currentLayers(run: Run): LayeredRefs {
	const global = readListed(run.files.global).listed;
	const project = run.trusted ? readListed(run.files.project, (ref) => projectRefProblem(ref, run.place)).listed : undefined;
	return resolveRefs({ global: global.refs, project: project?.refs ?? [] }, run.place);
}

/** The library of the Visible Ref called `name`, or the Global library when no Ref of that name is Visible. */
export function visibleLibrary(run: Run, name: string): LibraryName {
	const layer = currentLayers(run).layers.get(foldName(name));
	return layer === undefined ? "global" : libraryOf(layer);
}

/** The scope `in=here` gives a Ref: this repository's remote (origin first) when it has one, otherwise the directory. */
export function hereScope(run: Run): { key: "scope.remote" | "scope.path"; value: string } {
	const [remote] = run.place.remotes() ?? [];
	return remote === undefined ? { key: "scope.path", value: run.place.cwd } : { key: "scope.remote", value: normalizeRemote(remote) };
}
