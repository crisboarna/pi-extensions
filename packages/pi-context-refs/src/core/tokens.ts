/** A typed `#name`, a typed `#tag:<tag>` or a `[ref:...]` Placeholder found in message text. */
export interface RefToken {
	form: "typed" | "bundle" | "placeholder";
	/** The text after `#`, or between `[ref:` and `]`; for a Bundle, the Tag after `#tag:`. */
	target: string;
	/** Offset of the first character of the token. */
	start: number;
	/** Offset just past the last character of the token. */
	end: number;
}

// A Placeholder is bounded only by `]` (on one line). A typed token starts at `#` unless a word, URL or path character comes before it.
const REF_TOKEN = /\[ref:([^\]\n]+)\]|(?<![\p{L}\p{N}._\-/\\#&=?])#([Tt][Aa][Gg]:)?([A-Za-z0-9._-]+)/gu;

/** Every typed ref token and Placeholder in `text`, in order. Matching them to Refs is left to the caller. */
export function findRefTokens(text: string): RefToken[] {
	const tokens: RefToken[] = [];
	for (const match of text.matchAll(REF_TOKEN)) {
		const start = match.index;
		if (match[1] !== undefined) {
			tokens.push({ form: "placeholder", target: match[1], start, end: start + match[0].length });
			continue;
		}
		// Dots end a sentence as often as they sit in a name, so trailing ones are not part of it.
		const target = (match[3] ?? "").replace(/\.+$/, "");
		if (match[2] !== undefined && target.length > 0) {
			tokens.push({ form: "bundle", target, start, end: start + 1 + match[2].length + target.length });
		} else if (match[2] !== undefined) {
			// Only dots follow the colon, so `#tag` alone is the token: a Ref named tag.
			tokens.push({ form: "typed", target: match[2].slice(0, -1), start, end: start + match[2].length });
		} else if (target.length > 0) {
			tokens.push({ form: "typed", target, start, end: start + 1 + target.length });
		}
	}
	return tokens;
}
