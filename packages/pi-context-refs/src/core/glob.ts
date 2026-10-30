/** Characters that make a scope path a glob instead of a directory. */
export const GLOB_CHARACTERS = /[*?{]/;

const escapeRegExp = (text: string): string => text.replace(/[.+^$()|[\]\\{}*?]/g, "\\$&");

/** A test over a whole path for a glob: `*` is one segment, `**` any number of segments, `?` one character other than `/`, `{a,b}` alternatives. */
export function compileGlob(glob: string): (subject: string) => boolean {
	const pattern = new RegExp(`^${translate(glob)}$`);
	return (subject) => pattern.test(subject);
}

function translate(glob: string): string {
	let out = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob.charAt(index);
		if (char === "*") {
			const star = translateStars(glob, index, out);
			out = star.out;
			index = star.last;
		} else if (char === "{" && closingBrace(glob, index) >= 0) {
			const close = closingBrace(glob, index);
			out += `(?:${splitAlternatives(glob.slice(index + 1, close))
				.map(translate)
				.join("|")})`;
			index = close;
		} else {
			out += char === "?" ? "[^/]" : escapeRegExp(char);
		}
	}
	return out;
}

/** A run of `*` that starts at `index`: the regex so far with its translation added, and the index of the run's last character. */
function translateStars(glob: string, index: number, out: string): { out: string; last: number } {
	let end = index;
	while (glob[end] === "*") end += 1;
	const wholeSegment = (index === 0 || glob[index - 1] === "/") && end - index >= 2;
	if (wholeSegment && glob[end] === "/") return { out: `${out}(?:.*/)?`, last: end };
	if (wholeSegment && end === glob.length) {
		// The "/" before a closing "**" belongs to the optional tail, so "/work/**" also matches "/work".
		return { out: out.endsWith("/") ? `${out.slice(0, -1)}(?:/.*)?` : `${out}.*`, last: end - 1 };
	}
	return { out: `${out}[^/]*`, last: end - 1 };
}

function closingBrace(glob: string, open: number): number {
	let depth = 0;
	for (let index = open; index < glob.length; index += 1) {
		if (glob[index] === "{") depth += 1;
		else if (glob[index] === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function splitAlternatives(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] === "{") depth += 1;
		else if (body[index] === "}") depth -= 1;
		else if (body[index] === "," && depth === 0) {
			parts.push(body.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}
