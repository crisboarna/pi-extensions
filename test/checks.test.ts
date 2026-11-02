// Each repository gate runs against a small fixture repository and must catch
// the failure it exists for, and pass a clean tree.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { problems } from "../scripts/checks/commit-msg.ts";
import { DENIED, deniedWords } from "../scripts/lib/denylist.ts";

const SCRIPTS = fileURLToPath(new URL("../scripts/checks/", import.meta.url));
// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends. Run from the pre-push hook, the fixture's git init and
// the gates it spawns would act on the repository being pushed, so drop them before any test runs git.
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
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
	engines: { node: ">=22.19.0" },
	pi: { extensions: ["./src/index.ts"] },
	files: ["src", "README.md", "LICENSE"],
	peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.4.0 <2" },
	scripts: {
		test: "node --test",
		coverage: "node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90",
	},
	...overrides,
});

const CLEAN: Record<string, string> = {
	"package.json": JSON.stringify({
		name: "root",
		private: true,
		engines: { node: ">=22.19.0" },
		devDependencies: { typescript: "7.0.2", "@earendil-works/pi-coding-agent": "1.4.0" },
	}),
	"packages/pi-demo/package.json": JSON.stringify(manifest()),
	"packages/pi-demo/README.md": "# demo\n\nSee [the source](src/index.ts).\n",
	"packages/pi-demo/LICENSE": "MIT\n",
	"packages/pi-demo/src/index.ts":
		'import { join } from "node:path";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport { helper } from "./helper.ts";\nexport default function (_pi: ExtensionAPI): void {\n\thelper(join("a", "b"));\n}\n',
	"packages/pi-demo/src/helper.ts": "export function helper(_value: string): void {}\n",
	"packages/pi-demo/test/helper.test.ts": 'import { helper } from "../src/helper.ts";\nhelper("x");\n',
	"packages/pi-demo/test/all-modules.test.ts": 'import "../src/helper.ts";\n',
	".github/workflows/verify.yml": "jobs:\n  floor:\n    steps:\n      - with:\n          node-version: 22.19.0 # root engines.node\n",
	"package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/typescript": { license: "Apache-2.0" } } }),
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
	for (const check of ["manifests", "imports", "copies", "tui-coverage", "text", "file-sizes", "links", "licenses"]) {
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
	test("rejects pi's packages as dependencies", () => {
		const bad = manifest({ dependencies: { typebox: "1.3.27" } });
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(bad) }));
		assert.match(result.output, /typebox is provided by pi/);
	});
	test("requires the range CI tests on every pi peer, with a floor and a ceiling", () => {
		for (const range of ["*", ">=1.4.0", "^1.4.0", "~1.4.0", "1.4.0", ">=1.3.0 <2", ">=1.4.0 <3"]) {
			const bad = manifest({ peerDependencies: { "@earendil-works/pi-coding-agent": range } });
			const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(bad) }));
			assert.ok(!result.ok, range);
			assert.match(result.output, /peer @earendil-works\/pi-coding-agent must be ">=1.4.0 <2"/, range);
		}
		const ok = manifest({ peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.4.0 <2", "@earendil-works/pi-tui": ">=1.4.0 <2" } });
		assert.ok(run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(ok) })).ok);
	});
	test('keeps typebox a "*" peer, since pi bundles it', () => {
		const peers = { "@earendil-works/pi-coding-agent": ">=1.4.0 <2" };
		const star = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest({ peerDependencies: { ...peers, typebox: "*" } })) }));
		assert.ok(star.ok, star.output);
		const ranged = run(
			"manifests",
			repo({ "packages/pi-demo/package.json": JSON.stringify(manifest({ peerDependencies: { ...peers, typebox: ">=1 <2" } })) }),
		);
		assert.match(ranged.output, /peer typebox must use "\*"/);
	});
	test("requires the pi the repository tests with to be pinned inside the declared range", () => {
		const root = (devDependencies: Record<string, string>) =>
			JSON.stringify({ name: "root", private: true, engines: { node: ">=22.19.0" }, devDependencies });
		for (const pin of [undefined, "^1.4.0", "1.3.0", "2.0.0"]) {
			const devDependencies: Record<string, string> = pin ? { "@earendil-works/pi-coding-agent": pin } : { typescript: "7.0.2" };
			const result = run("manifests", repo({ "package.json": root(devDependencies) }));
			assert.match(result.output, /root devDependencies must pin @earendil-works\/pi-coding-agent exactly, inside >=1.4.0 <2/, String(pin));
		}
		assert.ok(run("manifests", repo({ "package.json": root({ "@earendil-works/pi-coding-agent": "1.5.0" }) })).ok);
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
				"packages/pi-demo/test/all-modules.test.ts": null,
			}),
		);
		assert.match(result.output, /scripts.test and scripts.coverage are required/);
		assert.match(result.output, /at least one \*\.test\.ts/);
	});
	test("holds every coverage threshold at 90 or more", () => {
		const low = manifest({ scripts: { test: "node --test", coverage: "node --test --test-coverage-lines=95 --test-coverage-branches=74" } });
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(low) }));
		assert.match(result.output, /--test-coverage-branches=90 or higher \(found 74\)/);
		assert.match(result.output, /--test-coverage-functions=90 or higher \(found none\)/);
		assert.doesNotMatch(result.output, /coverage-lines/);
	});
	test("holds every package to the root's Node version", () => {
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest({ engines: { node: ">=24" } })) }));
		assert.match(result.output, /engines.node must be ">=22.19.0"/);
	});
	test("requires CI to test the oldest supported Node", () => {
		const result = run(
			"manifests",
			repo({ ".github/workflows/verify.yml": "jobs:\n  tests:\n    steps:\n      - with:\n          node-version: 24.19.0\n" }),
		);
		assert.match(result.output, /verify.yml must run the tests on Node 22.19.0/);
		const loose = run("manifests", repo({ "package.json": JSON.stringify({ name: "root", private: true, engines: { node: ">=22" } }) }));
		assert.match(loose.output, /root engines.node must be ">=x.y.z"/);
	});
	test("rejects floating runtime dependencies", () => {
		const result = run("manifests", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest({ dependencies: { jiti: "^2.7.0" } })) }));
		assert.match(result.output, /must be pinned exactly/);
	});
});

describe("copies", () => {
	const copy = (pkg: string, content: string) => ({
		[`packages/${pkg}/package.json`]: JSON.stringify(
			manifest({ name: `@crisboarna/${pkg}`, repository: { type: "git", url: "", directory: `packages/${pkg}` } }),
		),
		[`packages/${pkg}/test/support/virtual-terminal.ts`]: content,
	});
	test("passes identical copies, a single copy and no copy", () => {
		const identical = repo({ ...copy("pi-demo", "same\n"), ...copy("pi-other", "same\n"), ...copy("pi-third", "same\n") });
		assert.ok(run("copies", identical).ok, run("copies", identical).output);
		const single = repo(copy("pi-demo", "only\n"));
		assert.ok(run("copies", single).ok, run("copies", single).output);
	});
	test("names the packages whose copy has drifted", () => {
		const result = run("copies", repo({ ...copy("pi-demo", "one\n"), ...copy("pi-other", "one\n"), ...copy("pi-third", "two\n") }));
		assert.ok(!result.ok);
		assert.match(result.output, /test\/support\/virtual-terminal\.ts: the copy in pi-third is not the copy in pi-demo, pi-other\n/);
		assert.match(result.output, /How to fix/);
	});
});

describe("tui-coverage", () => {
	const dialog = { "packages/pi-demo/src/dialog.ts": "export const open = (ctx) => ctx.ui.custom(() => ({}));\n" };
	const covering = (covers: string) => ({ "packages/pi-demo/test/tui/dialog.test.ts": `// covers: ${covers}\n` });
	test("passes a source file that takes keys when a test/tui test names it, and one that takes none", () => {
		const covered = repo({ ...dialog, ...covering("src/dialog.ts") });
		assert.ok(run("tui-coverage", covered).ok, run("tui-coverage", covered).output);
		const plain = repo({ "packages/pi-demo/src/plain.ts": "export const one = 1;\n" });
		assert.ok(run("tui-coverage", plain).ok, run("tui-coverage", plain).output);
	});
	test("names a source file that draws interactive UI and has no test/tui test", () => {
		const result = run("tui-coverage", repo(dialog));
		assert.ok(!result.ok);
		assert.match(result.output, /pi-demo: src\/dialog\.ts takes keys or draws UI, but no test\/tui test names it/);
		assert.match(result.output, /How to fix/);
	});
	test("catches every kind of interactive call, generic calls included", () => {
		for (const call of [
			"ctx.ui.custom<void>(f)",
			"ctx.ui.setEditorComponent(x)",
			"pi.registerShortcut('a', y)",
			"ctx.ui.addAutocompleteProvider(z)",
			"ctx.ui.onTerminalInput(w)",
			"await ctx.ui.select('Which?', rows)",
			"await run.ctx.ui.confirm('Sure?', 'text')",
			"await ctx.ui.input('Name', 'x')",
			"await ctx.ui.editor('Edit', text)",
			"await ui.confirm('Save?', diff)",
		]) {
			const result = run("tui-coverage", repo({ "packages/pi-demo/src/call.ts": `${call};\n` }));
			assert.ok(!result.ok, `${call} should need a test`);
		}
	});
	test("asks nothing of a file that only notifies, sets the status or has a select of its own", () => {
		for (const call of ["ctx.ui.notify('text')", "ctx.ui.setStatus('k', 'v')", "menu.select(rows)", "form.input.value", "myui.confirm(x)"]) {
			const result = run("tui-coverage", repo({ "packages/pi-demo/src/call.ts": `${call};\n` }));
			assert.ok(result.ok, `${call} needs no test: ${result.output}`);
		}
	});
	test("rejects a covers header that names a file that does not exist", () => {
		const result = run("tui-coverage", repo({ ...dialog, ...covering("src/dialog.ts, src/gone.ts") }));
		assert.ok(!result.ok);
		assert.match(result.output, /dialog\.test\.ts says it covers src\/gone\.ts, which does not exist/);
	});
});

describe("licenses", () => {
	const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } });
	test("passes permissive licences, dual licences and workspace links", () => {
		const result = run(
			"licenses",
			repo({
				"package-lock.json": lock({
					"node_modules/a": { license: "MIT" },
					"node_modules/b": { license: "MIT OR Apache-2.0" },
					"node_modules/c": { license: "(MIT AND BSD-3-Clause)" },
					"node_modules/@crisboarna/pi-demo": { link: true },
				}),
			}),
		);
		assert.ok(result.ok, result.output);
	});
	test("reads the old licenses array of an installed package when the lockfile records none", () => {
		const legacy = (type: string) => JSON.stringify({ name: "old", licenses: [{ type }] });
		const ok = run("licenses", repo({ "package-lock.json": lock({ "node_modules/old": {} }), "node_modules/old/package.json": legacy("Apache 2.0") }));
		assert.ok(ok.ok, ok.output);
		const gpl = run("licenses", repo({ "package-lock.json": lock({ "node_modules/old": {} }), "node_modules/old/package.json": legacy("GPL 3.0") }));
		assert.match(gpl.output, /node_modules\/old: "GPL-3.0" is not on the permissive allow-list/);
	});
	test("rejects copyleft, unknown and missing licences", () => {
		const result = run(
			"licenses",
			repo({
				"package-lock.json": lock({
					"node_modules/gpl": { license: "GPL-3.0-only" },
					"node_modules/mixed": { license: "MIT AND LGPL-2.1" },
					"node_modules/none": {},
				}),
			}),
		);
		assert.equal(result.ok, false);
		assert.match(result.output, /node_modules\/gpl: "GPL-3.0-only" is not on the permissive allow-list/);
		assert.match(result.output, /node_modules\/mixed: "MIT AND LGPL-2.1"/);
		assert.match(result.output, /node_modules\/none: no licence recorded/);
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
	test("allows only the pi-ai entry points pi maps for installed extensions", () => {
		const peers = { peerDependencies: { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*" } };
		const mapped = 'import { getModel } from "@earendil-works/pi-ai/models";\nvoid getModel;\n';
		const ok = run("imports", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest(peers)), "packages/pi-demo/src/helper.ts": mapped }));
		assert.ok(ok.ok, ok.output);
		const deep = 'import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";\nvoid classify;\n';
		const result = run("imports", repo({ "packages/pi-demo/package.json": JSON.stringify(manifest(peers)), "packages/pi-demo/src/helper.ts": deep }));
		assert.match(result.output, /"@earendil-works\/pi-ai\/api\/typesafe-system-one" is not an entry point pi maps/);
	});
	test("lets tests use the root devDependencies", () => {
		const result = run("imports", repo({ "packages/pi-demo/test/a.test.ts": 'import ts from "typescript";\nvoid ts;\n' }));
		assert.ok(result.ok, result.output);
	});
});

describe("denylist", () => {
	// Made-up words stand in for the real ones, which exist here only as hashes.
	const sha = (word: string) => createHash("sha256").update(word).digest("hex");
	const fake = new Set([sha("zorblax"), sha("quux42")]);
	test("finds denied words in any case, inside paths and globs, without spelling them out", () => {
		const hits = deniedWords('{ "remote": "*/Quux42/*", "note": "Zorblax seat", "path": "~/Projects/zorblax" }', fake);
		assert.deepEqual(hits.sort(), [sha("quux42").slice(0, 12), sha("zorblax").slice(0, 12)].sort());
		assert.ok(hits.every((hit) => !/zorblax|quux42/i.test(hit)));
		assert.deepEqual(deniedWords("zorblaxed quux420 acme-corp", fake), [], "only whole words count");
	});
	test("keeps only SHA-256 hashes in the shipped list", () => {
		assert.ok(DENIED.size > 0);
		for (const digest of DENIED) assert.match(digest, /^[0-9a-f]{64}$/);
	});
	test("rejects a commit message that holds a denied word", () => {
		assert.match(problems("docs(repo): note the Zorblax seat\n", fake).join("\n"), /a denied word \(sha256 [0-9a-f]{12}/);
		assert.deepEqual(problems("docs(repo): note the Acme seat\n", fake), []);
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

describe("readme", () => {
	const SOUND = "# demo\n\nRestart pi. Requires Node 22.19 or later and pi 1.4 up to, not including, 2.0.\n";
	const ROOT_README = "# root\n";
	const sound = (readme = SOUND) => repo({ "README.md": ROOT_README, "packages/pi-demo/README.md": readme });
	test("passes READMEs that state the versions in the convention's words", () => {
		const result = run("readme", sound());
		assert.ok(result.ok, result.output);
	});
	test("rejects a value typed into a badge, naming the README and the badge", () => {
		const badge = "[![node](https://img.shields.io/badge/node-%3E%3D22.19-green)](https://example.test)\n\n";
		const result = run("readme", sound(`# demo\n\n${badge}Restart pi. Requires Node 22.19 or later and pi 1.4 up to, not including, 2.0.\n`));
		assert.ok(!result.ok);
		assert.match(result.output, /packages\/pi-demo\/README\.md: badge "node" has a value typed into its address/);
	});
	test("rejects a pi range or Node floor that the manifests do not declare", () => {
		const old = run("readme", sound("# demo\n\nRequires Node 22.19 or later; checked with pi 1.4.\n"));
		assert.match(old.output, /must say "pi 1\.4 up to, not including, 2\.0"/);
		const open = run("readme", sound(`${SOUND}Works with pi 1.4 or later.\n`));
		assert.match(open.output, /says "pi 1\.4 or later"/);
		const node = run("readme", sound(SOUND.replace("22.19", "20.0")));
		assert.match(node.output, /must say "Node 22\.19 or later"/);
	});
	test("rejects more badges on the root README than the limit", () => {
		const badges = Array.from({ length: 9 }, (_, index) => `[![b${index}](https://img.shields.io/npm/v/p${index})](https://example.test)`).join(" ");
		const result = run("readme", repo({ "README.md": `# root\n\n${badges}\n`, "packages/pi-demo/README.md": SOUND }));
		assert.match(result.output, /README\.md: has 9 badges; the most is 8/);
	});
});
