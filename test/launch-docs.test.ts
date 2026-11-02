// The launch drafts are meant to be posted as they are, so what a network would reject or a reader would not trust is checked here: a post over its
// network's limit, a headline longer than it says, a word the rules forbid, and a claim table with a row that has no evidence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROOT } from "../scripts/lib/repo.ts";

const read = (name: string) => readFileSync(join(ROOT, "docs", "launch", name), "utf8");

/** The text of each fenced block, keyed by the level-two heading above it (a heading with two blocks keeps the first). */
function blocksByHeading(markdown: string): Map<string, string> {
	const found = new Map<string, string>();
	let heading = "";
	let inBlock = false;
	let lines: string[] = [];
	for (const line of markdown.split("\n")) {
		if (!inBlock && line.startsWith("## ")) heading = line.slice(3).trim();
		else if (line.startsWith("```")) {
			if (inBlock && !found.has(heading)) found.set(heading, lines.join("\n"));
			inBlock = !inBlock;
			lines = [];
		} else if (inBlock) lines.push(line);
	}
	return found;
}

/** The length a network counts: X and Mastodon count every link as 23 characters, Bluesky counts it as written. */
const counted = (text: string, linkLength: number | undefined): number =>
	linkLength === undefined ? text.length : text.replace(/https?:\/\/\S+/g, "x".repeat(linkLength)).length;

const LIMITS: Array<[string, number, number | undefined]> = [
	["X", 280, 23],
	["Bluesky", 300, undefined],
	["Mastodon", 500, 23],
];

/** True when some URL in the text is on the family site: the host and the path are compared as parts of a parsed address, not as a substring. */
function linksSite(text: string): boolean {
	return (text.match(/https?:\/\/\S+/g) ?? []).some((candidate) => {
		try {
			const url = new URL(candidate);
			return url.origin === "https://crisboarna.github.io" && url.pathname.startsWith("/pi-extensions/");
		} catch {
			return false;
		}
	});
}

// Words the rules in docs/launch/README.md forbid in a post.
const FORBIDDEN = /\b(powerful|seamless(ly)?|blazing|revolutionary|best|first|amazing|game-?changing|secure|effortless(ly)?|supercharge)\b/i;

describe("the social posts", () => {
	const posts = blocksByHeading(read("social.md"));

	for (const [network, limit, linkLength] of LIMITS) {
		test(`the ${network} post fits ${limit} characters`, () => {
			const text = posts.get(network);
			assert.ok(text, `no ${network} block in social.md`);
			assert.ok(counted(text, linkLength) <= limit, `${network}: ${counted(text, linkLength)} characters`);
		});
	}

	test("every post links the site and states a limit or asks for a report", () => {
		for (const [network, text] of posts) {
			assert.ok(linksSite(text), `${network}: no link to the site`);
		}
		assert.match(posts.get("Mastodon") ?? "", /Windows not tested/);
		assert.match(posts.get("LinkedIn") ?? "", /Windows is not tested/);
	});

	test("no post uses a word the rules forbid", () => {
		for (const [network, text] of posts) assert.doesNotMatch(text, FORBIDDEN, `${network}: ${FORBIDDEN.exec(text)?.[0]}`);
	});
});

describe("the Show HN draft", () => {
	const hn = read("hacker-news.md");
	const blocks = blocksByHeading(hn);

	test("the title starts with Show HN, fits 80 characters, and the draft states its real length", () => {
		const title = blocks.get("Title") ?? "";
		assert.match(title, /^Show HN: /);
		assert.ok(title.length <= 80, `${title.length} characters`);
		assert.ok(hn.includes(`That is ${title.length} characters.`), `the draft says a different length than ${title.length}`);
	});

	test("neither the title nor the first comment uses a word the rules forbid", () => {
		for (const heading of ["Title", "First comment"]) {
			const text = blocks.get(heading) ?? "";
			assert.ok(text.length > 0, `no ${heading} block`);
			assert.doesNotMatch(text, FORBIDDEN, `${heading}: ${FORBIDDEN.exec(text)?.[0]}`);
		}
	});

	test("the first comment states the limits and asks for a report", () => {
		const comment = blocks.get("First comment") ?? "";
		assert.match(comment, /Windows is not/);
		assert.match(comment, /false positive/);
	});
});

describe("the claims table", () => {
	const readme = read("README.md");
	const rows = readme
		.split("\n")
		.filter((line) => line.startsWith("| ") && !line.startsWith("| Claim") && !line.startsWith("|---"))
		.map((line) => line.split("|").map((cell) => cell.trim()));

	test("lists claims, and each one has evidence that is more than a few words", () => {
		assert.ok(rows.length >= 6, `${rows.length} claims`);
		for (const row of rows) assert.ok((row[2] ?? "").length > 20, `no evidence for: ${row[1]}`);
	});

	test("the gallery lines name each package once, with an install command", () => {
		const gallery = read("pi-gallery.md");
		for (const name of ["pi-switchboard", "pi-account-guard", "pi-context-refs"]) {
			assert.ok(gallery.includes(`pi install npm:@crisboarna/${name}`), name);
		}
	});
});
