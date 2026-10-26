// The site's link check: every relative href, src, poster and srcset in the
// built pages must name a file of the site, and every #anchor an id in the
// page it points at. Links that leave the site are not followed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function htmlFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return htmlFiles(path);
		return name.endsWith(".html") ? [path] : [];
	});
}

const idCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
	let ids = idCache.get(file);
	if (!ids) {
		ids = new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""));
		idCache.set(file, ids);
	}
	return ids;
}

/** The broken links of the site in `root`, as `<page>: "<target>" <why>`; empty when all resolve. */
export function checkSiteLinks(root: string): string[] {
	idCache.clear();
	const problems: string[] = [];
	for (const file of htmlFiles(root)) {
		const html = readFileSync(file, "utf8");
		const targets = [
			...[...html.matchAll(/\s(?:href|src|poster)="([^"]+)"/g)].map((match) => match[1] ?? ""),
			...[...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(",").map((entry) => entry.trim().split(/\s+/)[0] ?? "")),
		];
		for (const target of targets) {
			if (target === "" || /^([a-z]+:|\/\/)/.test(target)) continue;
			const [path = "", anchor] = target.split("#");
			const resolved = path === "" ? file : join(dirname(file), decodeURIComponent(path));
			const page = relative(root, file);
			if (!resolved.startsWith(root)) problems.push(`${page}: "${target}" leaves the site`);
			else if (!existsSync(resolved)) problems.push(`${page}: "${target}" does not exist`);
			else if (anchor && resolved.endsWith(".html") && !idsOf(resolved).has(anchor))
				problems.push(`${page}: "${target}" has no element with id ${anchor}`);
		}
	}
	return problems;
}
