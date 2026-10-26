import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { avoidTerms, findAvoidedTerms, lex, wordsOf } from "../support/glossary-scan.ts";
import { files, ROOT } from "../support/source-scan.ts";

interface Allowlist {
	/** Terms skipped everywhere in src/ because every use is ordinary English, not the domain concept. */
	ignoredTerms: Array<{ term: string; reason: string }>;
	/** Terms allowed in the listed files only. */
	allowedUses: Array<{ term: string; files: string[]; reason: string }>;
}

const glossary = readFileSync(join(ROOT, "GLOSSARY.md"), "utf8");
const allowlist = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "glossary-allowlist.json"), "utf8")) as Allowlist;

function found(source: string, glossaryText = glossary): string[] {
	return findAvoidedTerms(source, avoidTerms(glossaryText)).map((hit) => `${hit.kind}:${hit.word}`);
}

describe("glossary terms", () => {
	describe("reading the glossary", () => {
		it("reads every term of an _Avoid_ line, dropping the parenthetical notes", () => {
			const terms = avoidTerms("_Avoid_: Profile, Fallback zone, Label (a note, with a comma), provider (alone)\n");
			assert.deepEqual(
				terms.map((term) => term.words.join(" ")),
				["profile", "fallback zone", "label", "provider"],
			);
			assert.equal(terms[3]?.note, "alone");
		});

		it("reads the _Avoid_ lines of GLOSSARY.md", () => {
			const words = avoidTerms(glossary).map((term) => term.words.join(" "));
			assert.ok(words.includes("profile"));
			assert.ok(words.includes("path rule"));
		});
	});

	describe("finding a term in source", () => {
		const avoid = "_Avoid_: Profile, Fallback zone, provider (alone)\n";

		it("finds the term as a whole word of an identifier, in any case style", () => {
			assert.deepEqual(found("const userProfile = 1; const PROFILE_DIR = 2; const profile_id = 3;", avoid), [
				"identifier:profile",
				"identifier:profile",
				"identifier:profile",
			]);
		});

		it("finds the term in a string, also as a plural", () => {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is lexer input that contains a template literal on purpose
			assert.deepEqual(found('say("pick a profile"); say(`all profiles ${x}`);', avoid), ["string:profile", "string:profile"]);
		});

		it("finds a term of several words only when the words are adjacent", () => {
			assert.deepEqual(found('const fallbackZone = 1; const fallbackKey = 2; say("fallback zone");', avoid), [
				"identifier:fallback zone",
				"string:fallback zone",
			]);
		});

		it("does not find the term inside a longer word", () => {
			assert.deepEqual(found("const profiler = 1; const unprofiled = 2;", avoid), []);
		});

		it("ignores comments and regular expression literals", () => {
			assert.deepEqual(found("// the profile\n/* a profile */ const pattern = /[\"']profile/;", avoid), []);
		});

		it("reads code inside a template literal and the text around it", () => {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is lexer input that contains a template literal on purpose
			assert.deepEqual(found("say(`a ${profile} b`)", avoid), ["identifier:profile"]);
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is lexer input that contains a template literal on purpose
			assert.deepEqual(found("say(`profile ${x}`)", avoid), ["string:profile"]);
		});

		it("bans a term marked alone only in a string, and not before id", () => {
			assert.deepEqual(found("const provider = 1;", avoid), []);
			assert.deepEqual(found('say("the provider"); say("provider id"); say("providers");', avoid), ["string:provider", "string:provider"]);
		});

		it("reads strings with escapes and quotes inside a different quote", () => {
			assert.deepEqual(lex(`const a = "it's \\"x\\""; const b = 'say "y"';`).strings, ['it\'s "x"', 'say "y"']);
		});

		it("splits names into lowercase words", () => {
			assert.deepEqual(wordsOf("parseURLValue_two-three"), ["parse", "url", "value", "two", "three"]);
		});
	});

	describe("src/", () => {
		const ignored = new Set(allowlist.ignoredTerms.map((entry) => wordsOf(entry.term).join(" ")));

		it("has a reason on every allowlist entry", () => {
			for (const entry of [...allowlist.ignoredTerms, ...allowlist.allowedUses])
				assert.ok(entry.reason.trim().length > 0, `no reason for "${entry.term}"`);
		});

		it("uses no avoided term of GLOSSARY.md as a whole word in an identifier or a string", () => {
			const offenders: string[] = [];
			for (const path of files(join(ROOT, "src"), ".ts")) {
				const file = path.slice(ROOT.length + 1);
				const allowed = new Set(allowlist.allowedUses.filter((entry) => entry.files.includes(file)).map((entry) => wordsOf(entry.term).join(" ")));
				for (const hit of findAvoidedTerms(readFileSync(path, "utf8"), avoidTerms(glossary))) {
					if (!ignored.has(hit.word) && !allowed.has(hit.word)) offenders.push(`${file}: "${hit.word}" in ${hit.kind} ${hit.text}`);
				}
			}
			assert.deepEqual([...new Set(offenders)], []);
		});

		it("keeps no allowlist entry that the code no longer needs", () => {
			const sources = files(join(ROOT, "src"), ".ts").map((path) => ({
				file: path.slice(ROOT.length + 1),
				hits: findAvoidedTerms(readFileSync(path, "utf8"), avoidTerms(glossary)).map((hit) => hit.word),
			}));
			const stale: string[] = [];
			for (const entry of allowlist.ignoredTerms) {
				const word = wordsOf(entry.term).join(" ");
				if (!sources.some((source) => source.hits.includes(word))) stale.push(entry.term);
			}
			for (const entry of allowlist.allowedUses) {
				const word = wordsOf(entry.term).join(" ");
				for (const file of entry.files)
					if (!sources.find((source) => source.file === file)?.hits.includes(word)) stale.push(`${entry.term} in ${file}`);
			}
			assert.deepEqual(stale, []);
		});

		it("names only avoided terms in the allowlist", () => {
			const known = new Set(avoidTerms(glossary).map((term) => term.words.join(" ")));
			for (const entry of [...allowlist.ignoredTerms, ...allowlist.allowedUses])
				assert.ok(known.has(wordsOf(entry.term).join(" ")), `"${entry.term}" is not on an _Avoid_ line`);
		});
	});
});
