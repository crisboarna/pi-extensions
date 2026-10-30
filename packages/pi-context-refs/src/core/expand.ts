import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathRef, Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { bundleMembers } from "./resolve.ts";
import { findRefTokens } from "./tokens.ts";

/** What a Path needs to print itself: the session's working directory and the home directory. */
export interface ExpandEnv {
	cwd: string;
	home: string;
}

/** Replaces each ref token that names a Visible Path or Snippet Ref, and each `#tag:<tag>` of a Bundle, by its Expansion. Other tokens stay as typed. */
export function expandRefs(text: string, visible: ReadonlyMap<string, Ref>, env: ExpandEnv): string {
	const tokens = findRefTokens(text);
	// A Bundle leaves out every member the message names itself, and every member an earlier Bundle gave.
	const given = new Set(tokens.filter((token) => token.form !== "bundle").map((token) => foldName(token.target)));
	let result = "";
	let copiedUpTo = 0;
	for (const token of tokens) {
		const expansion = token.form === "bundle" ? bundleExpansion(token.target, visible, given, env) : tokenExpansion(token.target, visible, env);
		if (expansion === undefined) continue;
		// A Bundle with nothing left to add takes the space before it along, so no gap is left in the prose.
		const keep = expansion === "" && /[ \t]$/.test(text.slice(copiedUpTo, token.start)) ? token.start - 1 : token.start;
		result += text.slice(copiedUpTo, keep) + expansion;
		copiedUpTo = token.end;
	}
	return result + text.slice(copiedUpTo);
}

function tokenExpansion(target: string, visible: ReadonlyMap<string, Ref>, env: ExpandEnv): string | undefined {
	const ref = visible.get(foldName(target));
	return ref ? inlineExpansion(ref, env) : undefined;
}

/** The members of a Bundle not yet given, each as it would be on its own, apart by a space; undefined when no Visible Ref carries the Tag. */
function bundleExpansion(tag: string, visible: ReadonlyMap<string, Ref>, given: Set<string>, env: ExpandEnv): string | undefined {
	const members = bundleMembers(visible, tag);
	if (members.length === 0) return undefined;
	const pieces: string[] = [];
	for (const member of members) {
		const folded = foldName(member.name);
		if (given.has(folded)) continue;
		given.add(folded);
		// A File or Dynamic member stays a Placeholder, which is what a Context block hangs from.
		pieces.push(inlineExpansion(member, env) ?? `[ref:${member.name}]`);
	}
	return pieces.join(" ");
}

/** The inline text of a Snippet or Path; undefined for the kinds that become Context blocks. */
function inlineExpansion(ref: Ref, env: ExpandEnv): string | undefined {
	if (ref.kind === "snippet") return ref.text;
	if (ref.kind === "path") return pathText(ref, env);
	return undefined;
}

/** The target relative to the working directory when it lies inside it, absolute otherwise. */
function pathText(ref: PathRef, env: ExpandEnv): string {
	const absolute = resolve(env.cwd, expandHome(ref.path, env.home));
	const inside = relative(env.cwd, absolute);
	if (inside === "") return ".";
	return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? absolute : inside;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
