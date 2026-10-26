// Checks the bytes of every text file in the repository.
//
// - Invisible and bidirectional control characters are rejected. A model's
//   output can carry a zero-width space or a form feed where punctuation
//   belonged, and bidi controls can make code read differently from how it
//   runs ("Trojan Source"). Biome, tsc and markdownlint accept most of them.
// - Files use LF line endings and end with a newline.
// - No file holds a denied word (scripts/lib/denylist.ts): names of
//   employers, clients and their projects, kept only as hashes.
// - AGENTS.md files are loaded into every agent session, so each has a line
//   budget; CLAUDE.md only points at AGENTS.md so there is one source.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deniedWords } from "../lib/denylist.ts";
import { ROOT, repoFiles, reporter } from "../lib/repo.ts";

const BINARY = /\.(png|jpe?g|gif|webp|mp4|mov|webm|ico|woff2?|ttf|gz|tgz|zip|pdf)$/i;
const FORBIDDEN = new Map([
	["\u200B", "zero-width space"],
	["\u200C", "zero-width non-joiner"],
	["\u2060", "word joiner"],
	["\uFEFF", "byte order mark"],
	["\u00AD", "soft hyphen"],
	["\u000C", "form feed"],
	["\u000B", "vertical tab"],
	["\u202A", "bidi embedding (LRE)"],
	["\u202B", "bidi embedding (RLE)"],
	["\u202C", "bidi pop (PDF)"],
	["\u202D", "bidi override (LRO)"],
	["\u202E", "bidi override (RLO)"],
	["\u2066", "bidi isolate (LRI)"],
	["\u2067", "bidi isolate (RLI)"],
	["\u2068", "bidi isolate (FSI)"],
	["\u2069", "bidi isolate pop (PDI)"],
]);
const AGENTS_BUDGET = { root: 150, nested: 80 };

const report = reporter("text");
const fix = process.argv.includes("--fix");

for (const file of repoFiles()) {
	if (BINARY.test(file)) continue;
	const path = join(ROOT, file);
	let text = readFileSync(path, "utf8");
	for (const [index, line] of text.split("\n").entries()) {
		for (const prefix of deniedWords(line)) report.fail(`${file}:${index + 1}: a denied word (sha256 ${prefix}...); replace it with a fictional name`);
	}
	// Fixtures may hold forbidden bytes on purpose; only the denylist applies to them.
	if (file.includes("/test/fixtures/")) continue;
	if (text.includes("\uFFFD")) report.fail(`${file}: contains U+FFFD (a broken character from a bad decode)`);
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		for (const [char, name] of FORBIDDEN) {
			if (line.includes(char)) report.fail(`${file}:${index + 1}: ${name} (U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")})`);
		}
	}
	if (text.includes("\r")) {
		if (fix) text = text.replace(/\r\n?/g, "\n");
		else report.fail(`${file}: CRLF or CR line endings`);
	}
	if (text.length > 0 && !text.endsWith("\n")) {
		if (fix) text = `${text}\n`;
		else report.fail(`${file}: no newline at end of file`);
	}
	if (fix) writeFileSync(path, text);
	if (basename(file) === "AGENTS.md") {
		const budget = dirname(file) === "." ? AGENTS_BUDGET.root : AGENTS_BUDGET.nested;
		const count = text.trimEnd().split("\n").length;
		if (count > budget) report.fail(`${file}: ${count} lines, budget ${budget}; move detail into docs/ and link it`);
	}
	if (basename(file) === "CLAUDE.md") {
		if (text.trim() !== "@AGENTS.md") report.fail(`${file}: must contain only "@AGENTS.md" so instructions live in one file`);
		if (!existsSync(join(dirname(path), "AGENTS.md"))) report.fail(`${file}: no AGENTS.md next to it`);
	}
}

report.finish("delete the character (or retype the punctuation it replaced); run with --fix for line endings.");
