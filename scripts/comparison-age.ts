// Says how old each alternatives page is, so a page that has not been re-read for a while is found by a person, not by a reader.
//
//   node scripts/comparison-age.ts            list every page and its age in days; mark those older than 90
//   node scripts/comparison-age.ts --fail     also exit 1 when any page is older than 90 days
//
// Deliberately not one of the repository gates: a gate that depends on today's date turns main red with no code change. Run it before a release or a launch.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listPackages } from "./lib/repo.ts";

export const MAX_AGE_DAYS = 90;

/** The date a page says it was checked (`Checked 2026-11-03`), or undefined when it says none. */
export function checkedOn(markdown: string): string | undefined {
	return /\bChecked (\d{4}-\d{2}-\d{2})\b/.exec(markdown)?.[1];
}

/** Whole days from `date` (YYYY-MM-DD) to `today`; NaN for a date that is not one. */
export function ageInDays(date: string, today: Date): number {
	const then = Date.parse(`${date}T00:00:00Z`);
	if (Number.isNaN(then)) return Number.NaN;
	return Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - then) / 86_400_000);
}

export interface PageAge {
	page: string;
	checked: string | undefined;
	days: number;
	stale: boolean;
}

/** Every package's `docs/alternatives.md` with its age. A page with no date is stale: nobody can say how old it is. */
export function pageAges(today: Date, packages = listPackages()): PageAge[] {
	return packages
		.filter(({ path }) => existsSync(join(path, "docs", "alternatives.md")))
		.map(({ dir, path }) => {
			const checked = checkedOn(readFileSync(join(path, "docs", "alternatives.md"), "utf8"));
			const days = checked ? ageInDays(checked, today) : Number.NaN;
			return { page: `packages/${dir}/docs/alternatives.md`, checked, days, stale: Number.isNaN(days) || days > MAX_AGE_DAYS };
		});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const ages = pageAges(new Date());
	for (const age of ages)
		console.log(`${age.stale ? "STALE" : "ok   "}  ${age.page}  ${age.checked ? `checked ${age.checked}, ${age.days} days ago` : "no Checked date"}`);
	if (ages.length === 0) console.log("no alternatives pages found");
	process.exitCode = process.argv.includes("--fail") && ages.some((age) => age.stale) ? 1 : 0;
}
