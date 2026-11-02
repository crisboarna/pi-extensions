// What a release would publish, decided from the packages, what npm already holds and the git tags. A release that stopped half way (a tag
// with no version, a version with no tag) or a version that is not newer than the newest on npm must be named before the publish job runs,
// because npm cannot unpublish a version and a tag cannot be reused.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PackageFacts, releasePlan } from "../scripts/release/plan.ts";

const pkg = (name: string, version: string, extra: Partial<PackageFacts> = {}): PackageFacts => ({ name, version, ...extra });
const A = "@crisboarna/pi-a";
const B = "@crisboarna/pi-b";

describe("releasePlan", () => {
	it("publishes a version npm does not hold, with no tag yet", () => {
		const plan = releasePlan([pkg(A, "0.1.0")], { published: {}, tags: [] });
		assert.deepEqual(plan.problems, []);
		assert.deepEqual(plan.toPublish, [{ name: A, version: "0.1.0" }]);
		assert.deepEqual(plan.alreadyPublished, []);
	});

	it("leaves a version that is already on npm, with its tag, alone", () => {
		const plan = releasePlan([pkg(A, "0.1.0")], { published: { [A]: ["0.1.0"] }, tags: [`${A}@0.1.0`] });
		assert.deepEqual(plan, { toPublish: [], alreadyPublished: [{ name: A, version: "0.1.0" }], problems: [] });
	});

	it("skips a private package", () => {
		const plan = releasePlan([pkg("root", "0.0.0", { private: true })], { published: {}, tags: [] });
		assert.deepEqual(plan, { toPublish: [], alreadyPublished: [], problems: [] });
	});

	it("refuses a tag for a version npm does not hold: a release that stopped half way", () => {
		const plan = releasePlan([pkg(A, "0.2.0")], { published: { [A]: ["0.1.0"] }, tags: [`${A}@0.2.0`] });
		assert.deepEqual(plan.toPublish, []);
		assert.match(plan.problems.join("\n"), new RegExp(`tag ${A}@0\\.2\\.0 exists, but npm does not hold 0\\.2\\.0`));
	});

	it("refuses a version npm holds that has no tag: a publish that stopped before the tag", () => {
		const plan = releasePlan([pkg(A, "0.1.0")], { published: { [A]: ["0.1.0"] }, tags: [] });
		assert.match(plan.problems.join("\n"), /0\.1\.0 is on npm but has no git tag/);
	});

	it("refuses a version that is not newer than the newest on npm", () => {
		const plan = releasePlan([pkg(A, "0.1.5")], { published: { [A]: ["0.1.0", "0.2.0"] }, tags: [] });
		assert.deepEqual(plan.toPublish, []);
		assert.match(plan.problems.join("\n"), /0\.1\.5 is not newer than 0\.2\.0, the newest on npm/);
	});

	it("compares versions as numbers, so 0.10.0 is newer than 0.9.0", () => {
		assert.deepEqual(releasePlan([pkg(A, "0.10.0")], { published: { [A]: ["0.9.0"] }, tags: [] }).problems, []);
	});

	it("refuses a version that is not x.y.z", () => {
		const plan = releasePlan([pkg(A, "v1")], { published: {}, tags: [] });
		assert.match(plan.problems.join("\n"), /version "v1" must look like 1\.2\.3/);
	});

	it("names every problem, not only the first, and still plans the packages that are fine", () => {
		const plan = releasePlan([pkg(A, "0.1.0"), pkg(B, "0.3.0")], { published: { [A]: ["0.1.0"] }, tags: [] });
		assert.equal(plan.problems.length, 1);
		assert.deepEqual(plan.toPublish, [{ name: B, version: "0.3.0" }]);
	});
});
