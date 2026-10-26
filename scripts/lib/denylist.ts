// Words that must never appear in the repository or in a commit message:
// names of employers, clients and their projects that slipped into examples
// once. They are stored only as SHA-256 hashes of the lower-cased word, so
// this file does not contain what it blocks, and a hit is reported by its
// hash prefix, never spelled out in a log.
//
// To add a word: node -e 'console.log(require("node:crypto").createHash("sha256").update("<word>".toLowerCase()).digest("hex"))'
import { createHash } from "node:crypto";

export const DENIED: ReadonlySet<string> = new Set([
	"5b4a3fa8adeb5cf6348e447b55b72976b89137cba2f6c8cdf873869463557ff4",
	"3f99a60e482c9c62d0e241ccc24fc290f242a56bda1a26255d2dcf10a9446daa",
	"9fbb263d1b7cb7d1d4449e3985d400fe0cd6f569259470f21071fad6a36b4b90",
]);

const seen = new Map<string, string>();
const hash = (word: string): string => {
	let digest = seen.get(word);
	if (digest === undefined) {
		digest = createHash("sha256").update(word).digest("hex");
		seen.set(word, digest);
	}
	return digest;
};

/** Hash prefixes of the denied words in `text` (letters and digits, case-insensitive), one per distinct word. */
export function deniedWords(text: string, denied: ReadonlySet<string> = DENIED): string[] {
	const found = new Set<string>();
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		const digest = hash(word);
		if (denied.has(digest)) found.add(digest.slice(0, 12));
	}
	return [...found];
}
