const NAME = /^[A-Za-z0-9._-]+$/;

/** Why `name` cannot name a Ref, or undefined when it can. `what` is the word the message uses for it. */
export function nameProblem(name: string, what = "name"): string | undefined {
	if (name.length === 0) return `a ${what} cannot be empty`;
	if (!NAME.test(name)) return `a ${what} uses only letters, digits, ".", "-" and "_"`;
	if (name.endsWith(".")) return `a ${what} cannot end in ".", because a typed ref token ends before a trailing "."`;
	return undefined;
}

/** Why `tag` cannot be a Tag, or undefined when it can: a Tag takes the same characters as a name. */
export function tagProblem(tag: string): string | undefined {
	return nameProblem(tag, "tag");
}

/** The form names are compared in: names are case-insensitive. */
export function foldName(name: string): string {
	return name.toLowerCase();
}
