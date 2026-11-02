// `npm run pi-host` decides which pi a compatibility run installs. The rules must hold on the registry's real shape: a release younger than
// min-release-age is refused unless the run says it wants one, a release outside the declared range is never "latest", and a pre-release or
// a version the registry does not list is never picked by accident.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareVersions, parseRange, resolvePi } from "../scripts/lib/pi-versions.ts";
import { PI_PEER_RANGE } from "../scripts/lib/repo.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// What `npm view @earendil-works/pi-coding-agent time --json` returns, with the two bookkeeping keys it always has.
const TIMES: Record<string, string | undefined> = {
	created: daysAgo(90),
	modified: daysAgo(0),
	"1.3.0": daysAgo(60),
	"1.4.0": daysAgo(12),
	"1.4.1": daysAgo(10),
	"1.5.0": daysAgo(0.1),
	"2.0.0-beta.1": daysAgo(5),
	"2.0.0": daysAgo(1),
};
const RANGE = parseRange(">=1.4.0 <2");
const options = { times: TIMES, range: RANGE, now: NOW, days: 3, allowYoung: false };

describe("parseRange", () => {
	test("reads the range the packages declare", () => {
		assert.deepEqual(parseRange(">=1.4.0 <2"), { min: "1.4.0", below: "2.0.0" });
		assert.deepEqual(parseRange(">=1.4.0 <2.0.0"), { min: "1.4.0", below: "2.0.0" });
		assert.deepEqual(parseRange(PI_PEER_RANGE), { min: "1.4.0", below: "2.0.0" });
	});

	test("refuses a range that has no floor, no ceiling or another shape", () => {
		for (const range of ["*", ">=1.4.0", "<2", "^1.4.0", "~1.4.0", "1.4.0", ">=1.4 <2", ">=1.4.0 <2.1", ">1.4.0 <2"]) {
			assert.throws(() => parseRange(range), /must look like/, range);
		}
	});
});

describe("compareVersions", () => {
	test("compares numbers, not text", () => {
		assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
		assert.ok(compareVersions("1.4.0", "1.4.1") < 0);
		assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
		assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
	});
});

describe("resolvePi", () => {
	test("floor is the bottom of the range", () => {
		assert.equal(resolvePi("floor", options), "1.4.0");
	});

	test("floor refuses a bottom that is not published, or is younger than the age rule", () => {
		assert.throws(() => resolvePi("floor", { ...options, range: parseRange(">=1.4.2 <2") }), /not a published version/);
		assert.throws(() => resolvePi("floor", { ...options, range: parseRange(">=1.5.0 <2") }), /refuses packages younger than 3 days/);
	});

	test("latest is the newest release inside the range that is old enough", () => {
		// 1.5.0 is 0.1 days old, 2.0.0 is outside the range and 2.0.0-beta.1 is a pre-release
		assert.equal(resolvePi("latest", options), "1.4.1");
		assert.equal(resolvePi("latest", { ...options, now: new Date(NOW.getTime() + 5 * 86_400_000) }), "1.5.0");
	});

	test("latest, allowed to be young, takes the newest release inside the range and still never one outside it", () => {
		assert.equal(resolvePi("latest", { ...options, allowYoung: true }), "1.5.0");
	});

	test("latest refuses when nothing inside the range qualifies", () => {
		assert.throws(
			() => resolvePi("latest", { ...options, range: parseRange(">=3.0.0 <4") }),
			/no published version of pi is inside 3\.0\.0 to below 4\.0\.0/,
		);
		assert.throws(() => resolvePi("latest", { ...options, days: 365 }), /old enough/);
	});

	test("newest needs the run to say it wants a young release, and then ignores the range", () => {
		assert.throws(() => resolvePi("newest", options), /--allow-young/);
		assert.equal(resolvePi("newest", { ...options, allowYoung: true }), "2.0.0");
	});

	test("an exact version must be published and old enough, unless young releases are allowed", () => {
		assert.equal(resolvePi("1.4.1", options), "1.4.1");
		assert.equal(resolvePi("1.3.0", options), "1.3.0");
		assert.throws(() => resolvePi("1.5.0", options), /refuses packages younger than 3 days/);
		assert.equal(resolvePi("1.5.0", { ...options, allowYoung: true }), "1.5.0");
		assert.throws(() => resolvePi("1.4.2", options), /not a published version/);
	});

	test("refuses a spec that is not floor, latest, newest or an exact version, and never picks a pre-release", () => {
		for (const spec of ["1.4", "^1.4.0", "next", "", "1.4.0-beta.1", "2.0.0-beta.1"]) {
			assert.throws(() => resolvePi(spec, options), /is not floor, latest, newest or an exact version/, spec);
		}
	});

	test("a release with no publish time is never old enough", () => {
		const times: Record<string, string | undefined> = { ...TIMES, "1.4.2": undefined };
		assert.equal(resolvePi("latest", { ...options, times }), "1.4.1");
		assert.throws(() => resolvePi("1.4.2", { ...options, times }), /no publish time/);
	});
});
