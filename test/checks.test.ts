// Each repository gate runs against a small fixture repository and must catch
// the failure it exists for, and pass a clean tree.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { problems } from "../scripts/checks/commit-msg.ts";

const SCRIPTS = fileURLToPath(new URL("../scripts/checks/", import.meta.url));
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const manifest = (overrides: Record<string, unknown> = {}) => ({
	name: "@crisboarna/pi-demo",
	version: "0.1.0",
	description: "A demo package used by the repository tests.",
	type: "module",
	license: "MIT",
	author: "Test",
	keywords: ["pi-package"],
	repository: { type: "git", url: "git+https://github.com/crisboarna/pi-extensions.git", directory: "packages/pi-demo" },
	homepage: "https://github.com/crisboarna/pi-extensions/tree/main/packages/pi-demo#readme",
	bugs: { url: "https://github.com/crisboarna/pi-extensions/issues" },
	publishConfig: { access: "public", provenance: true },
	engines: { node: ">=22.19" },
	pi: { extensions: ["./src/index.ts"] },
	files: ["src", "README.md", "LICENSE"],
	peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
	scripts: { test: "node --test", coverage: "node --test --experimental-test-coverage --test-coverage-lines=90" },
	...overrides,
});

const CLEAN: Record<string, string> = {
	"package.json": JSON.stringify({ name: "root", private: true, devDependencies: { typescript: "7.0.2" } }),
	"packages/pi-demo/package.json": JSON.stringify(manifest()),
	"packages/pi-demo/README.md": "# demo\n\nSee [the source](src/index.ts).\n",
	"packages/pi-demo/LICENSE": "MIT\n",
	"packages/pi-demo/src/index.ts":
		'import { join } from "node:path";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport { helper } from "./helper.ts";\nexport default function (_pi: ExtensionAPI): void {\n\thelper(join("a", "b"));\n}\n',
	"packages/pi-demo/src/helper.ts": "export function helper(_value: string): void {}\n",
	"packages/pi-demo/test/helper.test.ts": 'import { helper } from "../src/helper.ts";\nhelper("x");\n',
	"AGENTS.md": "# Rules\n",
	"CLAUDE.md": "@AGENTS.md\n",
};

function repo(changes: Record<string, string | null> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "repo-check-"));
	made.push(root);
	const files: Record<string, string | null> = { ...CLEAN, ...changes };
	for (const [file, content] of Object.entries(files)) {
		if (content === null) continue;
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), file.endsWith(".json") && !content.endsWith("\n") ? `${content}\n` : content);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

function run(check: string, root: string, ...args: string[]): { ok: boolean; output: string } {
	const result = spawnSync(process.execPath, [join(SCRIPTS, `${check}.ts`), ...args], { env: { ...process.env, REPO_CHECK_ROOT: root }, encoding: "utf8" });
	return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe("every gate passes a clean tree", () => {
	for (const check of ["manifests", "imports", "text", "file-sizes", "links"]) {
		test(check, () => {
			const result = run(check, repo());
			assert.ok(result.ok, result.output);
		});
	}
});

describe("manifests", () => {
	test("rejects a name that does not match the folder", () => {
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest({ name: "pi-demo" })) }));
		assert.ok(!result.ok);
		assert.match(result.output, /name must be "@crisboarna\/pi-demo"/);
	});
	test("rejects pi's packages as dependencies and narrowed peers", () => {
		const bad = manifest({ dependencies: { typebox: "1.3.27" }, peerDependencies: { "@earendil-works/pi-coding-agent": "^1.4.0" } });
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(bad) }));
		assert.match(result.output, /typebox is provided by pi/);
		assert.match(result.output, /must use "\*"/);
	});
	test("rejects missing provenance and a pi entry outside files", () => {
		const bad = manifest({ publishConfig: { access: "public" }, files: ["README.md", "LICENSE"] });
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(bad) }));
		assert.match(result.output, /provenance must be true/);
		assert.match(result.output, /not covered by files/);
	});
	test("requires tests and coverage thresholds", () => {
		const result = run(
			"manifests",
			repo({
				"packages/pi-demo/package.json": JSON.stringify(manifest({ scripts: { test: "node --test" } })),
				"packages/pi-demo/test/helper.test.ts": null,
			}),
		);
		assert.match(result.output, /scripts.test and scripts.coverage are required/);
		assert.match(result.output, /at least one \*\.test\.ts/);
	});
	test("rejects floating runtime dependencies", () => {
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest({ dependencies: { jiti: "^2.7.0" } })) }));
		assert.match(result.output, /must be pinned exactly/);
	});
});

describe("imports", () => {
	test("rejects reaching into another package by path", () => {
		const result = run(
			"imports",
			repo({
				"packages/pi-demo/src/helper.ts": 'export { x } from "../../pi-other/src/x.ts";\n',
				"packages/pi-other/src/x.ts": "export const x = 1;\n",
				"packages/pi-other/package.json": JSON.stringify({ name: "@crisboarna/pi-other", private: true }),
			}),
		);
		assert.match(result.output, /leaves packages\/pi-demo/);
	});
	test("rejects undeclared packages, bare built-ins, typebox subpaths and missing extensions", () => {
		const source = 'import "left-pad";\nimport { readFileSync } from "fs";\nimport { Type } from "typebox/type";\nimport { a } from "./nope";\n';
		const result = run("imports", repo({ "packages/pi-demo/src/helper.ts": source }));
		assert.match(result.output, /"left-pad" is not declared/);
		assert.match(result.output, /use "node:fs"/);
		assert.match(result.output, /"typebox\/type" is not aliased by pi/);
		assert.match(result.output, /"\.\/nope" does not exist/);
	});
	test("lets tests use the root devDependencies", () => {
		const result = run("imports", repo({ "packages/pi-demo/test/a.test.ts": 'import ts from "typescript";\nvoid ts;\n' }));
		assert.ok(result.ok, result.output);
	});
});

describe("text", () => {
	test("rejects invisible and bidi characters, CRLF and a missing final newline", () => {
		const result = run("text", repo({ "packages/pi-demo/src/helper.ts": "export const a = 1;\u200B\r\nconst b = '\u202E';\nexport { b }" }));
		assert.match(result.output, /zero-width space/);
		assert.match(result.output, /bidi override \(RLO\)/);
		assert.match(result.output, /CRLF/);
		assert.match(result.output, /no newline at end of file/);
	});
	test("keeps CLAUDE.md a pointer and AGENTS.md within budget", () => {
		const result = run("text", repo({ "CLAUDE.md": "# Other rules\n", "AGENTS.md": `${"- rule\n".repeat(151)}` }));
		assert.match(result.output, /CLAUDE.md: must contain only "@AGENTS.md"/);
		assert.match(result.output, /AGENTS.md: 151 lines, budget 150/);
	});
});

describe("file-sizes", () => {
	test("caps new source files and lets baselined files grow by 10% only", () => {
		const big = "export const x = 1;\n".repeat(601);
		const root = repo({ "packages/pi-demo/src/big.ts": big });
		assert.match(run("file-sizes", root).output, /big\.ts: 601 lines; new source files are capped at 600/);
		assert.ok(run("file-sizes", root, "--update-baseline").ok);
		assert.ok(run("file-sizes", root).ok);
		writeFileSync(join(root, "packages/pi-demo/src/big.ts"), "export const x = 1;\n".repeat(700));
		assert.match(run("file-sizes", root).output, /baseline 601 allows up to 662/);
	});
});

describe("links", () => {
	test("rejects missing files and missing anchors", () => {
		const result = run("links", repo({ "packages/pi-demo/README.md": "# Demo\n\n[gone](docs/gone.md) and [anchor](#nowhere) and [ok](#demo)\n" }));
		assert.match(result.output, /"docs\/gone\.md" does not exist/);
		assert.match(result.output, /no heading for #nowhere/);
		assert.doesNotMatch(result.output, /#demo/);
	});
});

describe("commit messages", () => {
	test("accept the convention", () => {
		assert.deepEqual(problems("feat(pi-switchboard): add a strategy\n\nWhy it matters.\n"), []);
		assert.deepEqual(problems("build(deps): bump typescript\n"), []);
		assert.deepEqual(problems("ci: pin actions\n"), []);
	});
	test("reject a bad header, an unknown scope and AI attribution", () => {
		assert.match(problems("Added stuff.").join(), /is not "<type>\(<scope>\): <subject>"/);
		assert.match(problems("feat(nowhere): add x").join(), /scope "nowhere"/);
		assert.match(problems("fix: x\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>").join(), /AI attribution/);
		assert.match(problems("fix: x\n\nGenerated with [Claude Code](https://claude.ai)").join(), /AI attribution/);
		assert.match(problems("fix: Capitalised subject.").join(), /period/);
	});
});
