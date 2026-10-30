import { resolve } from "node:path";
import { compileGlob, GLOB_CHARACTERS } from "./glob.ts";
import type { RefScope } from "./library.ts";

/** Where the session is, with the file system and git injected. */
export interface Place {
	cwd: string;
	home: string;
	/** The real path of an existing path, or undefined when it does not exist. */
	realpath(path: string): string | undefined;
	/** The fetch URLs of the repository's remotes, or undefined when git cannot tell. Called only when a scope has a remote. */
	remotes(): readonly string[] | undefined;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A git remote URL as `host/path`, lower case: the scheme, the user and a `.git` suffix are dropped, and the `:` of an scp-like URL becomes `/`. */
export function normalizeRemote(url: string): string {
	let rest = url.trim();
	const hasScheme = SCHEME.test(rest);
	rest = rest.replace(SCHEME, "");
	const slash = rest.indexOf("/");
	const authority = slash < 0 ? rest : rest.slice(0, slash);
	const tail = slash < 0 ? "" : rest.slice(slash);
	const withoutUser = authority.slice(authority.lastIndexOf("@") + 1);
	// With a scheme the ":" after the host starts a port; without one it separates host and path (scp-like).
	const host = hasScheme ? withoutUser.replace(/:\d*$/, "") : withoutUser.replace(":", "/");
	return `${host}${tail}`
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.toLowerCase();
}

/** True when the Ref's scope applies at this place. Both a path and a remote must match when both are given; git is asked only for a remote, after the path matched. */
export function scopeMatches(scope: RefScope, place: Place): boolean {
	if (scope.path !== undefined && !pathMatches(scope.path, place)) return false;
	if (scope.remote === undefined) return true;
	const wanted = normalizeRemote(scope.remote);
	return (place.remotes() ?? []).some((url) => normalizeRemote(url) === wanted);
}

/** A bare directory means its whole subtree, anything with glob characters is matched against the working directory as a whole. */
function pathMatches(scopePath: string, place: Place): boolean {
	const here = place.realpath(place.cwd) ?? place.cwd;
	const expanded = expandHome(scopePath, place.home);
	if (GLOB_CHARACTERS.test(expanded)) return compileGlob(realLeadingDirectory(expanded, place))(here);
	const absolute = resolve(place.cwd, expanded);
	const base = trimTrailingSlashes(place.realpath(absolute) ?? absolute);
	return here === base || here.startsWith(base === "/" ? "/" : `${base}/`);
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function trimTrailingSlashes(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

/** Resolves the glob-free leading directories when they exist, so a symlinked prefix still matches the real working directory. */
function realLeadingDirectory(glob: string, place: Place): string {
	const segments = glob.split("/");
	const firstGlob = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment));
	const leading = segments.slice(0, firstGlob).join("/");
	if (leading === "") return glob;
	const real = place.realpath(leading);
	return real === undefined ? glob : [trimTrailingSlashes(real) === "/" ? "" : trimTrailingSlashes(real), ...segments.slice(firstGlob)].join("/");
}
