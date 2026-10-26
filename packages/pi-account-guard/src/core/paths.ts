/** Replaces the home directory prefix with `~` for display. */
export function displayPath(path: string, home: string): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Expands a leading `~` or `~/` to the home directory. */
export function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** The part of a path after its last slash. */
export function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
