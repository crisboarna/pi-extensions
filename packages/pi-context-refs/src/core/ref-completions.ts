import { foldName } from "./names.ts";
import { KINDS, LIBRARY_NAMES, SUBCOMMAND_HELP } from "./ref-command.ts";

export interface Completion {
	/** The whole argument text with the last word completed. */
	value: string;
	/** The completed word alone. */
	label: string;
	description?: string;
}

/** Completions for the text typed after `/ref `: the subcommand, then Ref names, kinds and `in=` values. `refNames` are the names in the library. */
export function completeArguments(typed: string, refNames: readonly string[]): Completion[] | null {
	const words = typed.split(/\s+/);
	const last = words.at(-1) ?? "";
	const before = words.slice(0, -1);
	const complete = (candidates: readonly string[], describe?: (candidate: string) => string): Completion[] | null => {
		const folded = foldName(last);
		const items = candidates
			.filter((candidate) => foldName(candidate).startsWith(folded))
			.map((candidate) => ({ value: [...before, candidate].join(" "), label: candidate, ...(describe && { description: describe(candidate) }) }));
		return items.length > 0 ? items : null;
	};
	if (words.length === 1) return complete(Object.keys(SUBCOMMAND_HELP), (name) => SUBCOMMAND_HELP[name] ?? "");
	if (last.startsWith("in=")) return completeLibrary(last, before);
	const [subcommand] = words;
	if ((subcommand === "edit" || subcommand === "remove") && words.length === 2) return complete(refNames);
	if (subcommand === "add" && words.length === 3) return complete(KINDS);
	return null;
}

function completeLibrary(last: string, before: string[]): Completion[] | null {
	const items = LIBRARY_NAMES.filter((name) => `in=${name}`.startsWith(last)).map((name) => ({
		value: [...before, `in=${name}`].join(" "),
		label: `in=${name}`,
	}));
	return items.length > 0 ? items : null;
}
