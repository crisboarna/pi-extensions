// A Dependabot pull request merges itself only when the policy says so, so the policy is tried on every case it has to refuse as well as the ones it
// allows, and the workflow that acts on it is checked for the guards that keep it from acting on anyone else's pull request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { decide, matchesPattern, PI_HOST_PATTERNS, parseDependencies, type UpdatedDependency } from "../scripts/lib/dependabot-policy.ts";
import { ROOT } from "../scripts/lib/repo.ts";

const dev = (over: UpdatedDependency): UpdatedDependency => ({
	dependencyName: "marked",
	dependencyType: "direct:development",
	updateType: "version-update:semver-patch",
	packageEcosystem: "npm_and_yarn",
	prevVersion: "18.1.1",
	...over,
});
const MINOR = "version-update:semver-minor";
const MAJOR = "version-update:semver-major";

describe("what may merge itself", () => {
	test("a patch or a minor of a development dependency at 1.0 or later", () => {
		assert.equal(decide([dev({})]).allowed, true);
		assert.equal(decide([dev({ updateType: MINOR })]).allowed, true);
	});

	test("a GitHub Actions or Docker update that is not a major, including a digest bump with no update type", () => {
		assert.equal(decide([{ dependencyName: "actions/checkout", packageEcosystem: "github_actions", updateType: MINOR }]).allowed, true);
		assert.equal(decide([{ dependencyName: "actions/checkout", packageEcosystem: "github-actions", updateType: MINOR }]).allowed, true);
		assert.equal(decide([{ dependencyName: "playwright", packageEcosystem: "docker" }]).allowed, true);
	});

	test("a group of updates when every one of them is allowed", () => {
		assert.equal(decide([dev({}), dev({ dependencyName: "tsx", updateType: MINOR, prevVersion: "4.20.0" })]).allowed, true);
	});
});

describe("what stays open for the maintainer", () => {
	test("a major update, whatever the ecosystem", () => {
		assert.equal(decide([dev({ updateType: MAJOR })]).allowed, false);
		assert.equal(decide([{ dependencyName: "actions/checkout", packageEcosystem: "github_actions", updateType: MAJOR }]).allowed, false);
		assert.equal(decide([{ dependencyName: "node", packageEcosystem: "docker", updateType: MAJOR }]).allowed, false);
	});

	test("a minor of a package below 1.0, because 0.x minors may break; a patch of one is fine", () => {
		const refused = decide([dev({ dependencyName: "pi-subagents", updateType: MINOR, prevVersion: "0.81.0" })]);
		assert.equal(refused.allowed, false);
		assert.match(refused.reason, /below 1\.0/);
		assert.equal(decide([dev({ dependencyName: "pi-subagents", prevVersion: "0.81.0" })]).allowed, true);
		assert.equal(decide([dev({ updateType: MINOR, prevVersion: undefined })]).allowed, false, "an unknown starting version is not trusted");
	});

	test("anything that decides which pi the suites run against, even as a patch", () => {
		for (const dependencyName of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox", "jiti"]) {
			assert.equal(decide([dev({ dependencyName })]).allowed, false, dependencyName);
		}
		assert.equal(decide([dev({ dependencyName: "typebox-extra" })]).allowed, true, "a name that only starts like a pattern is not matched");
	});

	test("a runtime or indirect dependency", () => {
		assert.equal(decide([dev({ dependencyType: "direct:production" })]).allowed, false);
		assert.equal(decide([dev({ dependencyType: "indirect" })]).allowed, false);
		assert.equal(decide([dev({ dependencyType: undefined })]).allowed, false);
	});

	test("one refused update in a group refuses the whole pull request, and says which", () => {
		const out = decide([dev({}), dev({ dependencyName: "typebox" })]);
		assert.equal(out.allowed, false);
		assert.match(out.reason, /^typebox: /);
	});

	test("an ecosystem the policy does not cover, an unreadable update type, and no information at all", () => {
		assert.equal(decide([dev({ packageEcosystem: "pip" })]).allowed, false);
		assert.equal(decide([dev({ updateType: undefined })]).allowed, false);
		assert.equal(decide([dev({ updateType: "version-update:something-new" })]).allowed, false);
		assert.equal(decide([{ packageEcosystem: "docker" }]).allowed, false, "an update with no name");
		assert.equal(decide([]).allowed, false);
	});
});

describe("reading the metadata", () => {
	test("keeps objects and drops everything else", () => {
		assert.deepEqual(parseDependencies('[{"dependencyName":"a"}, 3, null, "x", [1]]'), [{ dependencyName: "a" }]);
	});

	test("treats a missing, empty, broken or non-list value as no information", () => {
		for (const value of [undefined, "", "{", '{"a":1}', "null", "7"]) assert.deepEqual(parseDependencies(value), [], String(value));
	});

	test("matches a scope pattern by its scope and a plain pattern by its whole name", () => {
		assert.equal(matchesPattern("@earendil-works/pi-ai", "@earendil-works/*"), true);
		assert.equal(matchesPattern("@earendil-worksx/pi-ai", "@earendil-works/*"), false);
		assert.equal(matchesPattern("typebox", "typebox"), true);
		assert.equal(matchesPattern("typebox-extra", "typebox"), false);
	});
});

describe("the pi-host list agrees with Dependabot's own group", () => {
	test("PI_HOST_PATTERNS is the pi-host group in .github/dependabot.yml", () => {
		const config = readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8");
		const line = /pi-host:\s*\n\s*patterns: \[(.*)\]/.exec(config)?.[1];
		assert.ok(line, "a pi-host group with a patterns list");
		const patterns = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		assert.deepEqual(patterns, PI_HOST_PATTERNS);
	});
});

describe("the command", () => {
	const run = (dependencies: string) => {
		const dir = mkdtempSync(join(tmpdir(), "dependabot-policy-"));
		const output = join(dir, "output");
		const result = spawnSync(process.execPath, [join(ROOT, "scripts", "dependabot-auto-merge.ts")], {
			env: { ...process.env, DEPENDENCIES: dependencies, GITHUB_OUTPUT: output },
			encoding: "utf8",
		});
		let written = "";
		try {
			written = readFileSync(output, "utf8");
		} catch {
			written = "";
		}
		return { status: result.status, stdout: result.stdout, written };
	};

	test("writes allowed=true for an allowed update and exits 0", () => {
		const out = run(JSON.stringify([dev({})]));
		assert.equal(out.status, 0);
		assert.match(out.written, /^allowed=true\nreason=marked: a patch of a development dependency\n$/);
		assert.match(out.stdout, /may merge itself/);
	});

	test("writes allowed=false and still exits 0 for a refused one", () => {
		const out = run(JSON.stringify([dev({ updateType: MAJOR })]));
		assert.equal(out.status, 0);
		assert.match(out.written, /^allowed=false\n/);
		assert.match(out.stdout, /stays open for the maintainer/);
	});
});

describe("the workflow", () => {
	const text = readFileSync(join(ROOT, ".github", "workflows", "dependabot-auto-merge.yml"), "utf8");

	test("acts only on pull requests that Dependabot opened, and takes no secrets", () => {
		assert.match(text, /^on:\n {2}pull_request:\n/m);
		assert.doesNotMatch(text, /pull_request_target/);
		assert.match(text, /if: github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'$/m);
		assert.doesNotMatch(text, /secrets\./);
		assert.doesNotMatch(text, /github\.actor/, "an actor check can be spoofed");
	});

	test("starts with no permissions and grants the job only what enabling auto-merge needs", () => {
		assert.match(text, /^permissions: \{\}$/m);
		assert.match(text, /contents: write/);
		assert.match(text, /pull-requests: write/);
		assert.doesNotMatch(text, /(id-token|packages|actions|security-events): write/);
	});

	test("pins every action to a commit and checks out the default branch, never the pull request's code", () => {
		for (const use of text.matchAll(/uses: (\S+)/g)) assert.match(use[1] ?? "", /@[0-9a-f]{40}$/, use[1] ?? "");
		assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
		assert.match(text, /persist-credentials: false/);
	});

	test("enables auto-merge by squash only when the policy allowed it, so the required checks still decide", () => {
		assert.match(text, /if: steps\.policy\.outputs\.allowed == 'true'/);
		assert.match(text, /gh pr merge --auto --squash/);
		assert.doesNotMatch(text, /gh pr merge(?! --auto)/);
		assert.match(text, /node scripts\/dependabot-auto-merge\.ts/);
	});
});
