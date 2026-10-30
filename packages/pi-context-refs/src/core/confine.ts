import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Ref } from "./library.ts";

/** What the confinement rule needs from outside: the project directory and a way to follow symlinks. */
export interface ConfineEnv {
	/** The project directory. */
	cwd: string;
	home: string;
	/** The real path of an existing path, or undefined when it does not exist. */
	realpath(path: string): string | undefined;
	/** Where a symlink points, as written, or undefined when the path is not a symlink. It finds a link that points at nothing, which `realpath` cannot resolve. */
	linkTarget?(path: string): string | undefined;
}

/** Why a Ref of the Project library is refused, and the field it concerns. */
export interface ConfinementProblem {
	field: string;
	message: string;
}

/** A Project library Ref's Path or File target, and a Dynamic command's cwd, must lie inside the project after following symlinks (ADR 0003). Returns the problem, or undefined when the Ref is fine. */
export function confinementProblem(ref: Ref, env: ConfineEnv): ConfinementProblem | undefined {
	const target =
		ref.kind === "path" || ref.kind === "file"
			? { field: "path", path: ref.path }
			: ref.kind === "dynamic" && ref.cwd
				? { field: "cwd", path: ref.cwd }
				: undefined;
	if (!target) return undefined;
	const root = env.realpath(env.cwd) ?? env.cwd;
	const real = resolveThroughSymlinks(resolve(env.cwd, expandHome(target.path, env.home)), env, 0);
	if (real === undefined)
		return { field: target.field, message: `${target.path} follows symlinks that never end; a Project library Ref must stay inside the project` };
	if (isInside(root, real)) return undefined;
	return {
		field: target.field,
		message: `${target.path} resolves to ${real}, outside the project ${root}; a Project library Ref must stay inside the project`,
	};
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

const MAX_LINKS = 40;

/**
 * The real path of `path`, or when it does not exist, the real path of its nearest existing directory with the rest put back. A symlink that points at
 * nothing is followed to where it points. Undefined when the links never end.
 */
function resolveThroughSymlinks(path: string, env: ConfineEnv, links: number): string | undefined {
	let existing = path;
	let rest = "";
	for (;;) {
		const real = env.realpath(existing);
		if (real !== undefined) return rest === "" ? real : resolve(real, rest);
		const pointsTo = env.linkTarget?.(existing);
		if (pointsTo !== undefined) {
			if (links >= MAX_LINKS) return undefined;
			const next = resolve(dirname(existing), pointsTo);
			return resolveThroughSymlinks(rest === "" ? next : resolve(next, rest), env, links + 1);
		}
		const parent = dirname(existing);
		if (parent === existing) return path;
		rest = rest === "" ? existing.slice(parent.length).replace(/^\/+/, "") : `${existing.slice(parent.length).replace(/^\/+/, "")}/${rest}`;
		existing = parent;
	}
}

function isInside(root: string, path: string): boolean {
	const inside = relative(root, path);
	return inside === "" || (inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside));
}

/** Every rule of the Project library for one Ref: no scope (that belongs to the Global library), and the confinement rule. */
export function projectRefProblem(ref: Ref, env: ConfineEnv): ConfinementProblem | undefined {
	if (ref.scope !== undefined) return { field: "scope", message: "is only used in the Global library; a Project library Ref applies to its own project" };
	return confinementProblem(ref, env);
}
