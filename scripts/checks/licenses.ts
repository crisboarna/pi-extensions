// Checks that every installed package, runtime or dev, is under a permissive
// open-source licence, so the MIT packages published from here never pull in
// copyleft or unlicensed code. Reads the licence npm recorded in
// package-lock.json (or, when it records none, the installed manifest's old
// "licenses" array); workspace links are this repository's own MIT packages.
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

/**
 * The licence an installed package declares in npm's old form,
 * `"licenses": [{ "type": "Apache 2.0" }]`, which package-lock.json does not
 * record. Alternatives are joined with OR; spaces become hyphens ("Apache-2.0").
 */
function legacyLicence(path: string): string | undefined {
	const manifest = join(ROOT, path, "package.json");
	if (!existsSync(manifest)) return undefined;
	const { licenses } = readJson<{ licenses?: Array<{ type?: string }> }>(manifest);
	const types = (licenses ?? []).map((entry) => entry.type?.trim().replace(/\s+/g, "-")).filter((type): type is string => Boolean(type));
	return types.length > 0 ? types.join(" OR ") : undefined;
}

const report = reporter("licenses");
const lockPath = join(ROOT, "package-lock.json");
if (!existsSync(lockPath)) report.fail("package-lock.json is missing; run npm install");
else {
	const lock = readJson<{ packages?: Record<string, { license?: string; link?: boolean }> }>(lockPath);
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (path === "" || entry.link === true) continue;
		const licence = entry.license ?? legacyLicence(path);
		if (typeof licence !== "string") report.fail(`${path}: no licence recorded`);
		else if (!permitted(licence)) report.fail(`${path}: "${licence}" is not on the permissive allow-list`);
	}
}
report.finish(
	"replace the dependency with a permissively licensed one, or, after checking the licence is permissive and MIT-compatible, add it to ALLOWED in scripts/checks/licenses.ts.",
);
