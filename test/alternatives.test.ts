// A comparison page is only worth reading if it can be trusted, so what makes it trustworthy is checked: it says when it was checked, every project it names
// links to that project and names a version and a licence, the places the alternative is stronger are stated, what the README does not say is called "not
// established" and never "cannot", and no superlative or changing number is in it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ageInDays, checkedOn, MAX_AGE_DAYS, pageAges } from "../scripts/comparison-age.ts";
import { listPackages, ROOT } from "../scripts/lib/repo.ts";

const PACKAGES = ["pi-switchboard", "pi-account-guard", "pi-context-refs"];
const page = (name: string) => readFileSync(join(ROOT, "packages", name, "docs", "alternatives.md"), "utf8");
// Words that claim more than a README can show, or a number that changes daily.
const FORBIDDEN = /\b(best|better than|worst|powerful|seamless|blazing|superior|inferior|\d[\d,.]* (stars|downloads|dl\/mo))\b/i;

describe("every alternatives page", () => {
	for (const name of PACKAGES) {
		const text = page(name);

		test(`${name}: says when it was checked, and what it was checked against`, () => {
			assert.match(text, /Checked \d{4}-\d{2}-\d{2} against each project's README, its repository and the npm registry\./);
			assert.ok(checkedOn(text), "a Checked date the age script can read");
		});

		test(`${name}: invites a correction and says how the page is kept honest`, () => {
			assert.match(text, /open an issue/);
			assert.match(text, /## How this page is kept honest/);
			assert.match(text, /"Not established" means the README does not say/);
		});

		test(`${name}: names every project with a link, a version and a licence`, () => {
			const sections = text.split(/^### /m).slice(1);
			assert.ok(sections.length >= 2, "at least two projects read");
			for (const section of sections) {
				const title = section.split("\n")[0];
				assert.match(section, /\]\(https:\/\/github\.com\/[^)]+\)/, `${title}: a link to its repository`);
				assert.match(section, /version \d+\.\d+\.\d+/, `${title}: a version`);
				assert.match(section, /\bMIT\b/, `${title}: a licence`);
				assert.match(section, /\*\*What it is:\*\*/, `${title}: what it is`);
				assert.match(section, /\*\*Where it is stronger:\*\*/, `${title}: where it is stronger`);
			}
		});

		test(`${name}: says "not established" when a README is silent, and never claims what an alternative cannot do`, () => {
			assert.match(text, /[Nn]ot established/);
			const aboutOthers = text.slice(text.indexOf("## The ones read"));
			assert.doesNotMatch(aboutOthers, /(?<!")\b(it|they) cannot\b/i, "an unquoted claim about what an alternative cannot do");
		});

		test(`${name}: leaves out superlatives and numbers that change daily`, () => {
			assert.doesNotMatch(text, FORBIDDEN);
		});

		test(`${name}: names its own package, and says it reads no credential file only where its README says so`, () => {
			assert.ok(text.includes(name), "names the package");
			if (text.includes("reads no credential file"))
				assert.match(readFileSync(join(ROOT, "packages", name, "README.md"), "utf8"), /never reads `auth\.json`/);
		});
	}

	test("each package's README lists its alternatives page under Reference", () => {
		for (const name of PACKAGES) assert.match(readFileSync(join(ROOT, "packages", name, "README.md"), "utf8"), /\(docs\/alternatives\.md\)/, name);
	});
});

describe("comparison age", () => {
	test("reads the Checked date and counts whole days, in UTC", () => {
		assert.equal(checkedOn("x Checked 2026-11-03 against"), "2026-11-03");
		assert.equal(checkedOn("no date here"), undefined);
		assert.equal(ageInDays("2026-11-03", new Date("2026-11-03T23:59:59Z")), 0);
		assert.equal(ageInDays("2026-11-03", new Date("2026-11-04T00:00:00Z")), 1);
		assert.equal(ageInDays("2026-11-03", new Date("2027-02-01T12:00:00Z")), 90);
		assert.ok(Number.isNaN(ageInDays("not a date", new Date())));
	});

	test("marks a page older than the limit as stale, and a young one as fine", () => {
		const packages = listPackages().filter((pkg) => PACKAGES.includes(pkg.dir));
		const fresh = pageAges(new Date("2026-11-10T00:00:00Z"), packages);
		assert.equal(fresh.length, 3);
		assert.ok(
			fresh.every((age) => !age.stale && age.days === 7),
			JSON.stringify(fresh),
		);
		const old = pageAges(new Date("2027-03-01T00:00:00Z"), packages);
		assert.ok(
			old.every((age) => age.stale && age.days > MAX_AGE_DAYS),
			JSON.stringify(old),
		);
	});
});
