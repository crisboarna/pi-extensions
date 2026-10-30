import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathRef, Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { findRefTokens } from "./tokens.ts";

/** What a Path needs to print itself: the session's working directory and the home directory. */
export interface ExpandEnv {
	cwd: string;
	home: string;
}

/** Replaces each ref token that names a Visible Path or Snippet Ref by its Expansion. Other tokens stay as typed. */
export function expandRefs(text: string, visible: ReadonlyMap<string, Ref>, env: ExpandEnv): string {
	let result = "";
	let copiedUpTo = 0;
	for (const token of findRefTokens(text)) {
		const ref = visible.get(foldName(token.target));
		const expansion = ref ? inlineExpansion(ref, env) : undefined;
		if (expansion === undefined) continue;
		result += text.slice(copiedUpTo, token.start) + expansion;
		copiedUpTo = token.end;
	}
	return result + text.slice(copiedUpTo);
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
