import { join } from "node:path";
import { confinementProblem } from "../core/confine.ts";
import type { Ref } from "../core/library.ts";
import { createLibraryState, type LibraryState } from "../core/library-state.ts";
import { type Layer, resolveRefs } from "../core/resolve.ts";
import type { Place } from "../core/scope.ts";

/** What the libraries need from outside pi, so tests can stand in for the machine. */
export interface LibraryDeps {
	/** The Global library file. */
	libraryPath: string;
	home: string;
	readText: (path: string) => string | undefined;
	/** The real path of an existing path, or undefined when it does not exist. */
	realpath: (path: string) => string | undefined;
	/** The fetch URLs of the remotes of the repository that holds a directory, or undefined when git cannot tell. */
	readRemotes: (cwd: string) => string[] | undefined;
}

/** The parts of pi's context the libraries read. */
export interface LibraryContext {
	cwd: string;
	isProjectTrusted(): boolean;
}

/** The Refs to use for one send. */
export interface VisibleRefs {
	visible: Map<string, Ref>;
	layers: Map<string, Layer>;
	/** Warnings not shown before in this session. */
	notices: string[];
}

export interface Libraries {
	/** Forgets what the session has seen, so each warning shows once per session. */
	start(): void;
	/** Reads both libraries again and applies scope and precedence. The Project library is read only in a trusted project. */
	refresh(ctx: LibraryContext): VisibleRefs;
}

/** The Project library file of a project directory: exactly `<cwd>/.pi/pi-context-refs.json`, never a parent's. */
export const projectLibraryPath = (cwd: string): string => join(cwd, ".pi", "pi-context-refs.json");

/** The place the session is in, with git asked at most once per call of `remotes`. */
export function placeOf(ctx: { cwd: string }, deps: Pick<LibraryDeps, "home" | "realpath" | "readRemotes">): Place {
	return { cwd: ctx.cwd, home: deps.home, realpath: deps.realpath, remotes: () => deps.readRemotes(ctx.cwd) };
}

/** The Global and Project libraries as a session sees them: re-read on every refresh, the last good copy kept, precedence applied. */
export function createLibraries(deps: LibraryDeps): Libraries {
	let global: LibraryState | undefined;
	let project: { file: string; state: LibraryState } | undefined;
	return {
		start() {
			global = undefined;
			project = undefined;
		},
		refresh(ctx) {
			global ??= createLibraryState(deps.libraryPath, () => deps.readText(deps.libraryPath));
			const globalRead = global.refresh();
			const place = placeOf(ctx, deps);
			let projectRefs: readonly Ref[] = [];
			let projectNotices: string[] = [];
			if (ctx.isProjectTrusted()) {
				const file = projectLibraryPath(ctx.cwd);
				if (project?.file !== file) {
					project = {
						file,
						state: createLibraryState(
							file,
							() => deps.readText(file),
							(ref) => confinementProblem(ref, place),
						),
					};
				}
				const projectRead = project.state.refresh();
				projectRefs = projectRead.refs;
				projectNotices = projectRead.notices;
			}
			const { visible, layers } = resolveRefs({ global: globalRead.refs, project: projectRefs }, place);
			return { visible, layers, notices: [...globalRead.notices, ...projectNotices] };
		},
	};
}
