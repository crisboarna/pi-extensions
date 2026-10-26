// Checks that relative links in Markdown files point at files that exist, and
// that `#anchor` links point at a heading in the target. Moving or renaming a
// doc is the commonest way to break them, and nothing else notices. It also
// builds the family site and checks the links of every page.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { buildSite } from "../../tools/site/build.ts";
import { ROOT, repoFiles, reporter } from "../lib/repo.ts";

const report = reporter("links");
const markdown = repoFiles().filter((file) => file.endsWith(".md"));
const headingCache = new Map<string, Set<string>>();

/** GitHub's heading slugs: lowercase, punctuation dropped, spaces to hyphens. */
function slugs(file: string): Set<string> {
	const cached = headingCache.get(file);
	if (cached) return cached;
	const seen = new Map<string, number>();
	const out = new Set<string>();
	let fenced = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (/^(```|~~~)/.test(line)) fenced = !fenced;
		const match = fenced ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (!match?.[1]) continue;
		const base = match[1]
			.replace(/`/g, "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		out.add(count === 0 ? base : `${base}-${count}`);
	}
	headingCache.set(file, out);
	return out;
}

for (const file of markdown) {
	const text = readFileSync(join(ROOT, file), "utf8")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "");
	for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(?:img|a|video)[^>]+(?:src|href)="([^"]+)"/g)) {
		const target = match[1] ?? match[2];
		if (!target || /^(https?:|mailto:|data:)/.test(target)) continue;
		const [pathPart, anchor] = target.split("#");
		const resolved = pathPart ? normalize(join(ROOT, dirname(file), decodeURIComponent(pathPart))) : join(ROOT, file);
		if (!resolved.startsWith(ROOT)) {
			report.fail(`${file}: "${target}" points outside the repository`);
			continue;
		}
		if (!existsSync(resolved)) {
			report.fail(`${file}: "${target}" does not exist`);
			continue;
		}
		if (anchor && resolved.endsWith(".md") && statSync(resolved).isFile() && !slugs(resolved).has(anchor.toLowerCase())) {
			report.fail(`${file}: "${target}" has no heading for #${anchor}`);
		}
	}
}

// The site is built from the same Markdown into a scratch folder, so its pages are checked too.
if (existsSync(join(ROOT, "site", "templates", "page.html"))) {
	const scratch = mkdtempSync(join(tmpdir(), "site-links-"));
	try {
		for (const problem of buildSite(scratch)) report.fail(`site: ${problem}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

report.finish(
	"fix the path or anchor; links are relative to the file that contains them. Site links come from the same Markdown, built by tools/site/build.ts.",
);
