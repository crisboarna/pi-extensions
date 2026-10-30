/**
 * The name suggested for a Ref that saves the file at `path`: its file name, each character outside letters, digits, `.`, `-` and `_` turned into `-`,
 * trailing dots dropped, and `-2`, `-3` and so on until `taken` (which compares case-insensitively) no longer knows the name.
 */
export function suggestRefName(path: string, taken: (name: string) => boolean): string {
	const fileName = path.split(/[\\/]/u).at(-1) ?? "";
	const cleaned = [...fileName].map((char) => (/[A-Za-z0-9._-]/.test(char) ? char : "-")).join("");
	const base = cleaned.replace(/\.+$/u, "") || "ref";
	let name = base;
	for (let count = 2; taken(name); count++) name = `${base}-${count}`;
	return name;
}
