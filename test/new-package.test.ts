// `npm run new-package` promises a package that passes every repository gate the day it is created. The gates that read a package's README
// and manifest have moved since the scaffolder was written, so this runs the repository's own rules on what it generates.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { packageFiles } from "../scripts/lib/package-template.ts";
import { parseRange } from "../scripts/lib/pi-versions.ts";
import { badgeProblems, headingProblems, majorMinor, versionProblems } from "../scripts/lib/readme-rules.ts";
import { PI_PEER_RANGE } from "../scripts/lib/repo.ts";

const files = packageFiles({ name: "pi-example", description: "Shows what a generated package looks like.", node: ">=22.19.0", license: "MIT\n" });
const readme = files["README.md"] ?? "";
const manifest = JSON.parse(files["package.json"] ?? "{}") as {
	name: string;
	engines: { node: string };
	peerDependencies: Record<string, string>;
	publishConfig: { provenance: boolean };
};
const range = parseRange(PI_PEER_RANGE);
const piWords = `pi ${majorMinor(range.min)} up to, not including, ${majorMinor(range.below)}`;

describe("the files of a new package", () => {
	test("the README keeps the README rules: sections, badges and the declared versions", () => {
		assert.deepEqual(headingProblems(readme), []);
		assert.deepEqual(badgeProblems(readme), []);
		assert.deepEqual(versionProblems(readme, { node: "22.19", piMin: majorMinor(range.min), piBelow: majorMinor(range.below) }), []);
	});

	test("the manifest declares the pi range CI tests, the root's Node floor and provenance", () => {
		assert.equal(manifest.name, "@crisboarna/pi-example");
		assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], PI_PEER_RANGE);
		assert.equal(manifest.engines.node, ">=22.19.0");
		assert.equal(manifest.publishConfig.provenance, true);
	});

	test("the package starts with upgrade notes that name the pi range and how a break is announced", () => {
		const notes = files["docs/upgrading.md"] ?? "";
		assert.match(notes, /^# Upgrading/);
		assert.match(notes, /## How breaking changes are announced/);
		assert.ok(notes.includes(piWords), piWords);
	});

	test("the command it registers is the one the README's Quick start names", () => {
		assert.match(files["src/index.ts"] ?? "", /registerCommand\("example"/);
		assert.match(readme, /Run `\/example` in pi\./);
	});
});
