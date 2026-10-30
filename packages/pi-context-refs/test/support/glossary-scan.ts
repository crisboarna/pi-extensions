// Helpers for the GLOSSARY.md check: read the terms the glossary says to avoid
// and find them as whole words in the identifiers and strings of a source file.

/** One `_Avoid_:` entry: the words of the term, lowercased, and its parenthetical note if it has one. */
export interface AvoidTerm {
	words: string[];
	note: string | undefined;
}

/** The terms listed on the `_Avoid_:` lines of a glossary. */
export function avoidTerms(glossary: string): AvoidTerm[] {
	const terms: AvoidTerm[] = [];
	for (const line of glossary.split("\n")) {
		const match = /^_Avoid_:\s*(.+)$/.exec(line);
		if (!match) continue;
		// Split on commas that are not inside a parenthetical note.
		for (const entry of (match[1] as string).split(/,(?![^(]*\))/)) {
			const parts = /^\s*([^(]+?)\s*(?:\(([^)]*)\))?\s*$/.exec(entry);
			if (parts) terms.push({ words: wordsOf(parts[1] as string), note: parts[2] });
		}
	}
	return terms;
}

/** Lowercase words of a name or phrase, split at case changes, digits, underscores, dashes and spaces. */
export function wordsOf(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.toLowerCase());
}

/** Identifier names and string contents of TypeScript source. Comments and regular expression literals are skipped. */
export function lex(source: string): { identifiers: string[]; strings: string[] } {
	const identifiers: string[] = [];
	const strings: string[] = [];
	// Each open `${` of a template literal pushes the brace depth to return to.
	const templateDepths: number[] = [];
	let braceDepth = 0;
	let lastSignificant = "";
	let i = 0;

	const skipUntil = (end: string, from: number): void => {
		const found = source.indexOf(end, from);
		i = found === -1 ? source.length : found + (end === "\n" ? 0 : end.length);
	};

	const readTemplateText = (): void => {
		let text = "";
		while (i < source.length) {
			const char = source[i] as string;
			if (char === "\\") {
				i += 2;
			} else if (char === "`") {
				i++;
				strings.push(text);
				lastSignificant = "`";
				return;
			} else if (char === "$" && source[i + 1] === "{") {
				i += 2;
				strings.push(text);
				templateDepths.push(braceDepth);
				braceDepth++;
				lastSignificant = "{";
				return;
			} else {
				text += char;
				i++;
			}
		}
	};

	const readQuoted = (quote: string): void => {
		let text = "";
		i++;
		while (i < source.length && source[i] !== quote && source[i] !== "\n") {
			if (source[i] === "\\") i++;
			text += source[i] ?? "";
			i++;
		}
		i++;
		strings.push(text);
		lastSignificant = quote;
	};

	const readRegexLiteral = (): void => {
		let inClass = false;
		i++;
		while (i < source.length && (inClass || source[i] !== "/")) {
			if (source[i] === "\\") i++;
			else if (source[i] === "[") inClass = true;
			else if (source[i] === "]") inClass = false;
			i++;
		}
		i++;
		lastSignificant = "/";
	};

	const readWord = (pattern: RegExp, push: boolean, mark: string): void => {
		const start = i;
		while (i < source.length && pattern.test(source[i] as string)) i++;
		if (push) identifiers.push(source.slice(start, i));
		lastSignificant = mark;
	};

	/** Handles a brace or other punctuation; true when a `}` closed a template substitution and the template text resumes. */
	const readPunctuation = (char: string): boolean => {
		if (char === "{") braceDepth++;
		if (char === "}") {
			braceDepth--;
			if (templateDepths.at(-1) === braceDepth) {
				templateDepths.pop();
				i++;
				readTemplateText();
				return true;
			}
		}
		if (!/\s/.test(char)) lastSignificant = char;
		i++;
		return false;
	};

	const startsRegex = (): boolean => lastSignificant === "" || "(,=:[!&|?{};".includes(lastSignificant);

	while (i < source.length) {
		const char = source[i] as string;
		const next = source[i + 1];
		if (char === "/" && next === "/") skipUntil("\n", i);
		else if (char === "/" && next === "*") skipUntil("*/", i + 2);
		else if (char === '"' || char === "'") readQuoted(char);
		else if (char === "`") {
			i++;
			readTemplateText();
		} else if (char === "/" && startsRegex()) readRegexLiteral();
		else if (/[A-Za-z_$]/.test(char)) readWord(/[\w$]/, true, "a");
		else if (/\d/.test(char)) readWord(/[\w.]/, false, "0");
		else readPunctuation(char);
	}
	return { identifiers, strings };
}

/** A banned term found in a file, with the identifier or string it was found in. */
export interface Hit {
	word: string;
	kind: "identifier" | "string";
	text: string;
}

/**
 * The banned terms in the identifiers and strings of `source`. A term matches as whole words, with an optional
 * plural `s`. A term marked "(alone)" in the glossary is only banned in a string, and not when `id` follows it.
 * In an identifier such a word is the name of a field that pi or the config file defines.
 */
export function findAvoidedTerms(source: string, terms: AvoidTerm[]): Hit[] {
	const hits: Hit[] = [];
	const { identifiers, strings } = lex(source);
	const scan = (texts: string[], kind: Hit["kind"]): void => {
		for (const text of texts) {
			const words = wordsOf(text);
			for (const term of terms) {
				const alone = term.note?.includes("alone") === true;
				if (alone && kind === "identifier") continue;
				if (containsPhrase(words, term.words, alone ? ["id", "ids"] : [])) hits.push({ word: term.words.join(" "), kind, text });
			}
		}
	};
	scan(identifiers, "identifier");
	scan(strings, "string");
	return hits;
}

function containsPhrase(words: string[], phrase: string[], notFollowedBy: string[]): boolean {
	for (let start = 0; start + phrase.length <= words.length; start++) {
		const matches = phrase.every((part, offset) => {
			const word = words[start + offset] as string;
			return word === part || (offset === phrase.length - 1 && word === `${part}s`);
		});
		if (matches && !notFollowedBy.includes(words[start + phrase.length] ?? "")) return true;
	}
	return false;
}
