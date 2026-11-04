// The files of a new package, as scripts/new-package.ts writes them. Pure, so a test can run the repository's own README and manifest rules on
// what it generates: a new package must pass every gate the day it is created.

import { parseRange } from "./pi-versions.ts";
import { majorMinor } from "./readme-rules.ts";
import { PI_PEER_RANGE, REPOSITORY_URL, SCOPE } from "./repo.ts";

export interface PackageInput {
	/** The folder and unscoped npm name, such as `pi-example`. */
	name: string;
	description: string;
	/** The `engines.node` of the root package.json, such as `>=22.19.0`. */
	node: string;
	/** The text of the repository's LICENSE file. */
	license: string;
}

export function packageFiles({ name, description, node, license }: PackageInput): Record<string, string> {
	const full = `${SCOPE}/${name}`;
	const command = name.replace(/^pi-/, "");
	const range = parseRange(PI_PEER_RANGE);
	const piMin = majorMinor(range.min);
	const piBelow = majorMinor(range.below);
	const nodeFloor = majorMinor(node.replace(/^>=/, ""));
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
			engines: { node },
			pi: { extensions: ["./src/index.ts"] },
			files: ["src", "README.md", "LICENSE"],
			peerDependencies: { "@earendil-works/pi-coding-agent": PI_PEER_RANGE },
			scripts: {
				test: 'node --test --test-reporter=dot "test/**/*.test.ts"',
				coverage:
					'node --test --experimental-test-coverage --test-coverage-include="src/**" --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 "test/**/*.test.ts"',
			},
		}),
		"tsconfig.json": pretty({ extends: "../../tsconfig.base.json", include: ["src", "test"] }),
		"src/index.ts": `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { greeting } from "./greeting.ts";

/** ${description.replaceAll("*/", "* /")} */
export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("${name.replace(/^pi-/, "")}", {
		description: ${JSON.stringify(description)},
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

Run \`/${command}\` in pi.

## What you get

- **TODO** — replace with 5–7 benefit-first bullets (docs/conventions/readme.md).

## Reference

- [docs/upgrading.md](docs/upgrading.md): what an upgrade keeps and how a breaking change is announced.

## Requirements

Node ${nodeFloor} or later; pi ${piMin} up to, not including, ${piBelow}, the range CI tests. Linux is tested in CI; macOS is checked by hand, not in CI; Windows is not tested, so use WSL.

| How pi runs | What works | What does not |
|---|---|---|
| Interactive | TODO | TODO |
| Print (\`-p\`), JSON and RPC | TODO | TODO |

## Data and privacy

- **Network:** TODO name every call, or say there is none and that there is no telemetry.
- **Processes:** TODO name every program it starts, or say there is none.
- **Files it reads and writes:** TODO paths, from reading the source.

## Limitations

- Not yet verified in a live pi session.

## Uninstall

\`\`\`bash
pi remove npm:${full}
\`\`\`

## License

[MIT](LICENSE)
`,
		"docs/upgrading.md": `# Upgrading

Read this before you upgrade \`${full}\`.

## What an upgrade keeps

TODO list each file the package writes, its format version, and what the new version does with an old one (docs/conventions/upgrading.md).

## Which pi it works with

pi ${piMin} up to, not including, ${piBelow}. CI runs the real-pi tests with the oldest and the newest release of that range.

## How breaking changes are announced

A breaking change is a major release. Its changelog entry says what broke in one sentence, and a section headed with the version, such as \`## 2.0\`, is added below with the old behaviour, the new behaviour and the exact edit to make.

No release has broken anything yet; this is the first release.
`,
		"AGENTS.md": `# ${name}

${description} These rules add to the repository \`AGENTS.md\`.

## Code map

- \`src/index.ts\` registers the command; behaviour lives in named modules under \`src/\`.
`,
		"CLAUDE.md": "@AGENTS.md\n",
		LICENSE: license,
	};

	return files;
}
