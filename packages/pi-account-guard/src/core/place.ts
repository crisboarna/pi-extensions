import type { PlaceRuleEntry } from "./config.ts";
import { normalizeRemoteUrl } from "./remote.ts";

export type PlaceRule = Pick<PlaceRuleEntry, "path" | "remote" | "zone">;

/** Filesystem facts the matcher needs; the pi glue supplies the real ones. */
export interface PathReader {
	home: string;
	/** The real path of an existing path, or `undefined` when it does not exist. */
	realpath(path: string): string | undefined;
}

/** The fetch URLs of every configured remote, or the reason git could not tell (DESIGN.md section 7). */
export type RemoteUrls = { ok: true; urls: string[] } | { ok: false; reason: string };

/** Reads the remotes of the place; the pi glue runs git, tests inject fakes. */
export type RemoteReader = () => RemoteUrls;

export type PlaceZone =
	| {
			ok: true;
			zone: string;
			/** Index of the deciding rule in file order; absent when the default zone applies. */
			ruleIndex?: number;
	  }
	| { ok: false; reason: string };

const GLOB_CHARACTERS = /[*?{]/;

/**
 * The first matching rule in file order decides; no match falls to the default zone. `placePath` must already be a real path.
 * `readRemotes` runs only when a rule's remote condition has to be checked, so a place that a path-only rule decides never calls git.
 * When git fails and a rule with a remote condition could apply, the place is undecidable.
 */
export function resolvePlaceZone(placePath: string, rules: PlaceRule[], defaultZone: string, paths: PathReader, readRemotes: RemoteReader): PlaceZone {
	let remotes: RemoteUrls | undefined;
	const normalizedRemotes = (): RemoteUrls => (remotes ??= readNormalizedRemotes(readRemotes));
	for (const [index, rule] of rules.entries()) {
		if (rule.path !== undefined && !compileRulePath(rule.path, paths)(placePath)) continue;
		if (rule.remote !== undefined) {
			const known = normalizedRemotes();
			if (!known.ok) return { ok: false, reason: known.reason };
			const matches = compileRemote(rule.remote);
			if (!known.urls.some(matches)) continue;
		}
		return { ok: true, zone: rule.zone, ruleIndex: index };
	}
	return { ok: true, zone: defaultZone };
}

function readNormalizedRemotes(readRemotes: RemoteReader): RemoteUrls {
	const result = readRemotes();
	return result.ok ? { ok: true, urls: result.urls.map(normalizeRemoteUrl) } : result;
}

/** Remote conditions are globs over `host/path`, matched case-insensitively. */
function compileRemote(remote: string): (normalizedUrl: string) => boolean {
	const pattern = new RegExp(`^${globSource(remote)}$`, "i");
	return (normalizedUrl) => pattern.test(normalizedUrl);
}

/** Replaces the home directory prefix with `~` for display. */
export function displayPath(path: string, home: string): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function compileRulePath(rulePath: string, paths: PathReader): (placePath: string) => boolean {
	const expanded = expandTilde(rulePath, paths.home);
	if (!GLOB_CHARACTERS.test(expanded)) {
		const base = trimTrailingSlashes(paths.realpath(expanded) ?? expanded);
		return (placePath) => placePath === base || placePath.startsWith(`${base}/`);
	}
	const pattern = new RegExp(`^${globSource(realLeadingDirectory(expanded, paths))}$`);
	return (placePath) => pattern.test(placePath);
}

function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

function trimTrailingSlashes(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

/** Resolves the glob-free leading segments of a glob path when they exist, so a symlinked prefix still matches the real path. */
function realLeadingDirectory(glob: string, paths: PathReader): string {
	const segments = glob.split("/");
	const firstGlob = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment));
	const prefix = segments.slice(0, firstGlob).join("/");
	if (prefix === "") return glob;
	const real = paths.realpath(prefix);
	return real === undefined ? glob : [trimTrailingSlashes(real) === "/" ? "" : trimTrailingSlashes(real), ...segments.slice(firstGlob)].join("/");
}

/** Translates a glob to a regular expression source: `*` one segment, `**` any depth, `?` one character, `{a,b}` alternatives. */
function globSource(glob: string): string {
	let out = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index]!;
		if (char === "*") {
			let end = index;
			while (glob[end] === "*") end++;
			const wholeSegmentBefore = index > 0 && glob[index - 1] === "/";
			if (end - index >= 2 && wholeSegmentBefore && glob[end] === "/") {
				out += "(?:[^/]+/)*";
				index = end;
			} else if (end - index >= 2 && wholeSegmentBefore && end === glob.length) {
				out = `${out.slice(0, -1)}(?:/.*)?`;
				index = end - 1;
			} else {
				out += "[^/]*";
				index = end - 1;
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "{") {
			const close = matchingBrace(glob, index);
			if (close < 0) {
				out += "\\{";
			} else {
				out += `(?:${splitAlternatives(glob.slice(index + 1, close)).map(globSource).join("|")})`;
				index = close;
			}
		} else {
			out += char.replace(/[.+^$()|[\]\\}]/g, "\\$&");
		}
	}
	return out;
}

function matchingBrace(glob: string, open: number): number {
	let depth = 0;
	for (let index = open; index < glob.length; index++) {
		if (glob[index] === "{") depth++;
		else if (glob[index] === "}" && --depth === 0) return index;
	}
	return -1;
}

function splitAlternatives(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		if (body[index] === "{") depth++;
		else if (body[index] === "}") depth--;
		else if (body[index] === "," && depth === 0) {
			parts.push(body.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}
