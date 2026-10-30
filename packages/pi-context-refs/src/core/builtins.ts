import type { DynamicRef } from "./library.ts";
import { foldName } from "./names.ts";

type BuiltinRef = DynamicRef & { command: string[] };

/** The Built-in Refs: git commands that need no setup. They sit below every saved Ref. */
export const BUILTIN_REFS: readonly BuiltinRef[] = [
	{ name: "diff", kind: "dynamic", command: ["git", "diff"], description: "Unstaged changes" },
	{ name: "staged", kind: "dynamic", command: ["git", "diff", "--staged"], description: "Staged changes" },
	{ name: "status", kind: "dynamic", command: ["git", "status", "--short"], description: "Changed files" },
	{ name: "log", kind: "dynamic", command: ["git", "log", "--oneline", "-20"], description: "The last 20 commits" },
];

/** The Built-in Refs left on by the `builtins` setting: all for `true`, none for `false`, all but the named ones for a list. */
export function builtinRefs(setting: boolean | readonly string[]): readonly BuiltinRef[] {
	if (setting === true) return BUILTIN_REFS;
	if (setting === false) return [];
	const off = new Set(setting.map(foldName));
	return BUILTIN_REFS.filter((builtin) => !off.has(foldName(builtin.name)));
}

/** Whether `ref` is one of the Built-in Refs themselves, and not a saved Ref that shares a name with one. */
export const isBuiltin = (ref: unknown): boolean => BUILTIN_REFS.some((builtin) => builtin === ref);
