// Checks that every installed package, runtime or dev, is under a permissive
// open-source licence, so the MIT packages published from here never pull in
// copyleft or unlicensed code. Reads the licence npm recorded in
// package-lock.json; workspace links are this repository's own MIT packages.
//
// An SPDX expression passes when every AND term passes and at least one
// alternative of each OR passes. Add a licence to ALLOWED only after checking
// that it is permissive and compatible with MIT.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson, reporter } from "../lib/repo.ts";

const ALLOWED = new Set(["0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MIT", "Python-2.0", "PSF-2.0", "Unlicense"]);

/** Whether an SPDX licence expression only allows use under ALLOWED licences. */
export function permitted(expression: string): boolean {
	const terms = expression.replace(/[()]/g, " ").split(/\s+AND\s+/);
	return terms.every((term) => term.split(/\s+OR\s+/).some((choice) => ALLOWED.has(choice.trim())));
}

const report = reporter("licenses");
const lockPath = join(ROOT, "package-lock.json");
if (!existsSync(lockPath)) report.fail("package-lock.json is missing; run npm install");
else {
	const lock = readJson<{ packages?: Record<string, { license?: string; link?: boolean }> }>(lockPath);
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (path === "" || entry.link === true) continue;
		if (typeof entry.license !== "string") report.fail(`${path}: no licence recorded`);
		else if (!permitted(entry.license)) report.fail(`${path}: "${entry.license}" is not on the permissive allow-list`);
	}
}
report.finish(
	"replace the dependency with a permissively licensed one, or, after checking the licence is permissive and MIT-compatible, add it to ALLOWED in scripts/checks/licenses.ts.",
);
