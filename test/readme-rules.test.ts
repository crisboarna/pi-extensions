// The README rules a script can check: badges stay on one line, at most 8, with no value typed into an address; and the Node and pi versions
// are stated in the convention's words and agree with the manifests. Each rule must catch the failure it exists for, and let a clean README pass.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { badgeProblems, MAX_BADGES, majorMinor, versionProblems } from "../scripts/lib/readme-rules.ts";

const EXPECTED = { node: "22.19", piMin: "1.4", piBelow: "2.0" };
const badge = (alt: string, src: string): string => `[![${alt}](${src})](https://example.test/${alt})`;
const SOUND = "Restart pi. Requires Node 22.19 or later and pi 1.4 up to, not including, 2.0.";

describe("majorMinor", () => {
	test("drops the patch", () => {
		assert.equal(majorMinor("22.19.0"), "22.19");
		assert.equal(majorMinor("1.4"), "1.4");
	});
});

describe("badgeProblems", () => {
	test("accepts badges read from a registry, CI or the repository", () => {
		const line = [
			badge("npm", "https://img.shields.io/npm/v/@crisboarna/pi-demo"),
			badge("license", "https://img.shields.io/github/license/crisboarna/pi-extensions"),
		].join(" ");
		assert.deepEqual(badgeProblems(`# Title\n\n${line}\n`), []);
	});

	test("refuses a value typed into a static badge, and names the badge", () => {
		const problems = badgeProblems(`${badge("node", "https://img.shields.io/badge/node-%3E%3D22.19-green")}\n`);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /badge "node" has a value typed into its address/);
	});

	test("allows the one static link badge, the try-it page", () => {
		assert.deepEqual(badgeProblems(`${badge("try it", "https://img.shields.io/badge/try-in_your_browser-informational")}\n`), []);
	});

	test("refuses more badges than the limit, wherever they are on the line", () => {
		const many = Array.from({ length: MAX_BADGES + 1 }, (_, index) => badge(`b${index}`, `https://img.shields.io/npm/v/pkg${index}`)).join(" ");
		assert.match(badgeProblems(`${many}\n`)[0] ?? "", new RegExp(`has ${MAX_BADGES + 1} badges; the most is ${MAX_BADGES}`));
		const exact = Array.from({ length: MAX_BADGES }, (_, index) => badge(`b${index}`, `https://img.shields.io/npm/v/pkg${index}`)).join(" ");
		assert.deepEqual(badgeProblems(`${exact}\n`), []);
	});

	test("ignores images that are not badges: a banner in the page body is not on a badge line", () => {
		assert.deepEqual(
			badgeProblems('<picture><img src="https://img.shields.io/badge/x-y-green"></picture>\n![alt](https://img.shields.io/badge/x-y-green)\n'),
			[],
		);
	});
});

describe("versionProblems", () => {
	test("accepts the convention's words", () => {
		assert.deepEqual(versionProblems(SOUND, EXPECTED), []);
	});

	test("refuses a Node floor that is not the package's", () => {
		assert.match(versionProblems(SOUND.replace("22.19", "22.0"), EXPECTED).join("\n"), /must say "Node 22\.19 or later"/);
	});

	test("refuses a pi range that is not the one CI tests", () => {
		assert.match(versionProblems(SOUND.replace("pi 1.4 up", "pi 1.3 up"), EXPECTED).join("\n"), /must say "pi 1\.4 up to, not including, 2\.0"/);
		assert.match(versionProblems(SOUND.replace("2.0", "3.0"), EXPECTED).join("\n"), /must say "pi 1\.4 up to, not including, 2\.0"/);
	});

	test('refuses "or later" after a pi version, which promises every future pi', () => {
		const problems = versionProblems(`${SOUND}\nWorks with pi 1.4 or later.`, EXPECTED);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /says "pi 1\.4 or later"; a pi version needs an upper bound/);
	});

	test("refuses a README that states neither version", () => {
		assert.equal(versionProblems("Restart pi.", EXPECTED).length, 2);
	});
});
