// The policy behind `node scripts/tools/audit.ts`: which advisories fail, and what a valid exception is.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type AuditException, advisoriesOf, exceptionsProblem, judge } from "../scripts/lib/audit.ts";

const report = {
	vulnerabilities: {
		"@earendil-works/pi-coding-agent": { severity: "moderate", via: ["minimatch"] },
		minimatch: {
			severity: "moderate",
			via: [{ source: 1, name: "minimatch", title: "DoS", url: "https://github.com/advisories/GHSA-g3hv-75wg-m249", severity: "moderate" }],
		},
		lowly: { severity: "low", via: [{ title: "Minor", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "low" }] },
	},
};
const exception: AuditException = { advisory: "GHSA-g3hv-75wg-m249", package: "minimatch", reason: "not shipped", expires: "2026-12-01" };

describe("advisoriesOf", () => {
	test("lists the advisories an entry names itself, not the packages that only depend on a vulnerable one", () => {
		assert.deepEqual(advisoriesOf(report), [{ advisory: "GHSA-g3hv-75wg-m249", package: "minimatch", severity: "moderate", title: "DoS" }]);
	});

	test("leaves out what is below the minimum severity, and reads a report with nothing in it", () => {
		assert.equal(advisoriesOf(report, "high").length, 0);
		assert.equal(advisoriesOf({}).length, 0);
	});
});

describe("judge", () => {
	const advisories = advisoriesOf(report);

	test("fails an advisory with no exception", () => {
		assert.deepEqual(
			judge(advisories, [], "2026-11-01").failures.map((failure) => failure.why),
			["no exception"],
		);
	});

	test("passes an advisory with an exception for that advisory and that package", () => {
		assert.deepEqual(judge(advisories, [exception], "2026-11-01"), { failures: [], unused: [] });
		assert.equal(judge(advisories, [exception], "2026-12-01").failures.length, 0, "the last day still holds");
	});

	test("fails once the exception has expired", () => {
		assert.match(judge(advisories, [exception], "2026-12-02").failures[0]?.why ?? "", /expired on 2026-12-01/u);
	});

	test("does not let an exception for the same advisory in another package, or another advisory in this package, cover it", () => {
		assert.equal(judge(advisories, [{ ...exception, package: "other" }], "2026-11-01").failures.length, 1);
		assert.equal(judge(advisories, [{ ...exception, advisory: "GHSA-aaaa-bbbb-cccc" }], "2026-11-01").failures.length, 1);
	});

	test("reports an exception that matches nothing as unused, without failing", () => {
		const verdict = judge([], [exception], "2026-11-01");
		assert.deepEqual(verdict, { failures: [], unused: [exception] });
	});
});

describe("exceptionsProblem", () => {
	test("accepts a complete entry and an empty list", () => {
		assert.equal(exceptionsProblem([exception]), undefined);
		assert.equal(exceptionsProblem([]), undefined);
	});

	test("names what is wrong", () => {
		assert.match(exceptionsProblem({}) ?? "", /must be a list/u);
		assert.match(exceptionsProblem([{ ...exception, reason: "" }]) ?? "", /"reason" is missing/u);
		assert.match(exceptionsProblem([{ ...exception, advisory: "CVE-1" }]) ?? "", /GHSA id/u);
		assert.match(exceptionsProblem([{ ...exception, expires: "soon" }]) ?? "", /YYYY-MM-DD/u);
		assert.match(exceptionsProblem([{ ...exception, expires: "2026-13-45" }]) ?? "", /YYYY-MM-DD/u);
	});
});
