// Creates a new package that already passes every repository gate.
//
//   npm run new-package -- <name> "<one-sentence description>"
//
// <name> is the folder and the unscoped npm name, e.g. pi-example; it is
// published as @crisboarna/<name>. The package gets a minimal extension, a
// unit test, README, AGENTS.md, LICENSE and a pack snapshot, and the script
// runs `npm install` so the workspace is linked.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPOSITORY_URL, ROOT, SCOPE } from "./lib/repo.ts";

const [name, description] = process.argv.slice(2);
if (!name || !/^pi-[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !description || description.length < 20) {
	console.error('Usage: npm run new-package -- <pi-name> "<one-sentence description, 20+ characters>"');
	console.error("The name starts with pi- and uses lower-case letters, digits and hyphens.");
	process.exit(1);
}
const dir = join(ROOT, "packages", name);
if (existsSync(dir)) {
	console.error(`packages/${name} already exists.`);
	process.exit(1);
}
const full = `${SCOPE}/${name}`;
const pretty = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;
const files: Record<string, string> = {
	"package.json": pretty({
		name: full,
		version: "0.0.0",
		description,
		type: "module",
		license: "MIT",
		author: "Cristian Boarna",
		keywords: ["pi-package", "pi-extension"],
		repository: { type: "git", url: REPOSITORY_URL, directory: `packages/${name}` },
		homepage: `https://github.com/crisboarna/pi-extensions/tree/main/packages/${name}#readme`,
		bugs: { url: "https://github.com/crisboarna/pi-extensions/issues" },
		publishConfig: { access: "public", provenance: true },
		engines: { node: ">=22.19" },
		pi: { extensions: ["./src/index.ts"] },
		files: ["src", "README.md", "LICENSE"],
		peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
		scripts: {
			test: 'node --test --test-reporter=dot "test/**/*.test.ts"',
			coverage:
				'node --test --experimental-test-coverage --test-coverage-include="src/**" --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 "test/**/*.test.ts"',
		},
	}),
	"tsconfig.json": pretty({ extends: "../../tsconfig.base.json", include: ["src", "test"] }),
	"src/index.ts": `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { greeting } from "./greeting.ts";

/** ${description} */
export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("${name.replace(/^pi-/, "")}", {
		description: "${description.replace(/"/g, '\\"')}",
		handler: async (_args, ctx) => {
			ctx.ui.notify(greeting(ctx.cwd), "info");
		},
	});
}
`,
	"src/greeting.ts": `/** The message the command shows; kept apart from index.ts so tests can import it. */
export function greeting(cwd: string): string {
	return \`${name} is running in \${cwd}\`;
}
`,
	"test/greeting.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "../src/greeting.ts";

test("greeting names the working directory", () => {
	assert.equal(greeting("/work"), "${name} is running in /work");
});
`,
	"test/extension.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

test("the command shows the greeting for the working directory", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notices: string[] = [];
	const pi = { registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command) };
	extension(pi as unknown as ExtensionAPI);
	await commands.get("${name.replace(/^pi-/, "")}")?.handler("", { cwd: "/work", ui: { notify: (message: string) => notices.push(message) } });
	assert.deepEqual(notices, ["${name} is running in /work"]);
});
`,
	"test/all-modules.test.ts": `// Imports every module under src/, so the coverage run measures files that no
// other test loads (node --test only reports files it saw).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dirname, "..", "src");

test("every source module loads", async () => {
	const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
	assert.ok(files.length > 0);
	for (const file of files) await import(pathToFileURL(join(SRC, file)).href);
});
`,
	"README.md": `# ${full}

${description}

## Install

\`\`\`bash
pi install npm:${full}
\`\`\`

Restart pi.

## Quick start

Run \`/${name.replace(/^pi-/, "")}\` in pi.

## What you get

- **TODO** — replace with 5–7 benefit-first bullets (docs/conventions/readme.md).

## Limitations

- Not yet verified in a live pi session.

## License

[MIT](LICENSE)
`,
	"AGENTS.md": `# ${name}

${description} These rules add to the repository \`AGENTS.md\`.

## Code map

- \`src/index.ts\` registers the command; behaviour lives in named modules under \`src/\`.
`,
	"CLAUDE.md": "@AGENTS.md\n",
	LICENSE: readFileSync(join(ROOT, "LICENSE"), "utf8"),
};

for (const [file, content] of Object.entries(files)) {
	const path = join(dir, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
for (const template of [".github/ISSUE_TEMPLATE/bug.yml", ".github/ISSUE_TEMPLATE/feature.yml"]) {
	const path = join(ROOT, template);
	const text = readFileSync(path, "utf8");
	// Insert the package as the first option, at the indentation of the existing options.
	const match = /^( *)options:\n( *)- /m.exec(text);
	if (match && !text.includes(`- ${name}\n`)) {
		const item = `${match[2]}- ${name}\n`;
		writeFileSync(path, text.replace(`${match[1]}options:\n`, `${match[1]}options:\n${item}`));
	}
}
execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
execFileSync(join(ROOT, "node_modules/.bin/biome"), ["format", "--write", `packages/${name}`, ".github/ISSUE_TEMPLATE"], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/checks/pack.ts", "--update"], { cwd: ROOT, stdio: "inherit" });
console.log(`\nCreated packages/${name} (${full}). Next: add it to the table in README.md, write the README, then npm run check.`);
