const NAME = /^[A-Za-z0-9._-]+$/;

/** Why `name` cannot name a Ref, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
	if (name.length === 0) return "a name cannot be empty";
	if (!NAME.test(name)) return 'a name uses only letters, digits, ".", "-" and "_"';
	if (name.endsWith(".")) return 'a name cannot end in ".", because a typed ref token ends before a trailing "."';
	return undefined;
}

/** The form names are compared in: names are case-insensitive. */
export function foldName(name: string): string {
	return name.toLowerCase();
}
