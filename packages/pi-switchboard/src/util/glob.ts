/** Case-insensitive glob where `*` matches any run of characters and `?` one character. */
export function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (const char of pattern) {
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else source += char.replace(/[\\^$.+()|[\]{}]/gu, "\\$&");
	}
	return new RegExp(`^${source}$`, "iu");
}

export function matchGlob(pattern: string, value: string): boolean {
	return globToRegExp(pattern).test(value);
}
