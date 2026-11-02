// `npm run coexist` installs other people's code outside the repository, where the repository's .npmrc does not apply. The pin rules it
// applies itself must refuse what that .npmrc would: a version younger than `min-release-age`, one that has no publish time, and one
// that is not exact.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { minReleaseAgeDays, problemsWith, readPins } from "../scripts/lib/coexist-pins.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const PIN = { name: "pi-demo", version: "1.2.3" };

describe("readPins", () => {
	test("reads exact pins", () => {
		assert.deepEqual(readPins({ packages: [PIN, { name: "@scope/other", version: "0.0.1" }] }), [PIN, { name: "@scope/other", version: "0.0.1" }]);
	});

	test("refuses a missing or empty list, an entry without a name or version, and a version that is not exact", () => {
		assert.throws(() => readPins(null), /non-empty "packages" list/);
		assert.throws(() => readPins({ packages: [] }), /non-empty "packages" list/);
		assert.throws(() => readPins({ packages: [{ name: "pi-demo" }] }), /packages\[0\] needs a "name" and a "version"/);
		for (const version of ["^1.2.3", "~1.2.3", "latest", "1.2", "1.2.3-beta.1", ">=1.0.0"]) {
			assert.throws(() => readPins({ packages: [{ name: "pi-demo", version }] }), /exact version/, version);
		}
	});

	test("reads the pins this repository ships", () => {
		const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../scripts/coexist.json", import.meta.url)), "utf8")) as unknown;
		assert.ok(readPins(shipped).length > 0);
	});
});

describe("minReleaseAgeDays", () => {
	test("reads the number from an .npmrc, and from this repository's own", () => {
		assert.equal(minReleaseAgeDays("save-exact=true\nmin-release-age=7\nfund=false\n"), 7);
		assert.ok(minReleaseAgeDays(readFileSync(fileURLToPath(new URL("../.npmrc", import.meta.url)), "utf8")) >= 1);
	});

	test("refuses an .npmrc that sets none, so the rule cannot be dropped by accident", () => {
		assert.throws(() => minReleaseAgeDays("save-exact=true\n"), /no min-release-age/);
		assert.throws(() => minReleaseAgeDays("# min-release-age=3\n"), /no min-release-age/);
	});
});

describe("problemsWith", () => {
	test("accepts a pin that is old enough, including one exactly that old", () => {
		assert.deepEqual(problemsWith([PIN], { "pi-demo@1.2.3": daysAgo(40) }, NOW, 3), []);
		assert.deepEqual(problemsWith([PIN], { "pi-demo@1.2.3": daysAgo(3) }, NOW, 3), []);
	});

	test("names a pin that is too young and says how old it is", () => {
		const problems = problemsWith([PIN], { "pi-demo@1.2.3": daysAgo(2.5) }, NOW, 3);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /pi-demo@1\.2\.3 was published 2\.5 days ago; the repository's \.npmrc refuses packages younger than 3 days/);
	});

	test("names a pin with no publish time, whether the registry lacks it or the time is not a date", () => {
		assert.match(problemsWith([PIN], {}, NOW, 3)[0] ?? "", /pi-demo@1\.2\.3 has no publish time on the registry/);
		assert.match(problemsWith([PIN], { "pi-demo@1.2.3": "yesterday" }, NOW, 3)[0] ?? "", /no publish time/);
	});

	test("reports every pin that fails, and only those", () => {
		const pins = [PIN, { name: "pi-new", version: "0.1.0" }, { name: "pi-gone", version: "9.9.9" }];
		const problems = problemsWith(pins, { "pi-demo@1.2.3": daysAgo(30), "pi-new@0.1.0": daysAgo(1) }, NOW, 3);
		assert.equal(problems.length, 2);
		assert.match(problems[0] ?? "", /pi-new@0\.1\.0 was published/);
		assert.match(problems[1] ?? "", /pi-gone@9\.9\.9 has no publish time/);
	});
});
