# Package conventions

What every package under `packages/` contains, and why. `scripts/checks/manifests.ts` and `scripts/checks/imports.ts` enforce the manifest and import rules; `npm run new-package` creates a package that already passes them.

## Layout

```text
packages/<name>/
├── package.json      published as @crisboarna/<name>
├── README.md         the npm page and the gallery page (docs/conventions/readme.md)
├── LICENSE           MIT
├── AGENTS.md         package rules for agents (80 lines at most)
├── CLAUDE.md         contains only "@AGENTS.md"
├── CHANGELOG.md      written by Changesets; never edit by hand
├── tsconfig.json     extends ../../tsconfig.base.json
├── src/index.ts      the extension factory pi loads
├── src/…             behaviour, in modules tests can import
└── test/             unit/ and integration/ tests (node --test)
```

Design notes go in `DESIGN.md`, terms in `GLOSSARY.md`, decisions in `docs/adr/`, all inside the package.

## package.json

| Field | Rule | Why |
|---|---|---|
| `name` | `@crisboarna/<folder>` | One name per folder; the scope keeps every name available and shows authorship in every install line |
| `version` | semver, changed only by Changesets | Releases come from changesets, not hand edits |
| `description` | one sentence in the user's words | Shown in npm search and the pi gallery |
| `keywords` | include `pi-package` | Makes the package eligible for the [pi gallery](https://pi.dev/packages) |
| `repository` | this repository, with `directory: packages/<folder>` | npm links to the right folder; provenance names the source |
| `homepage`, `bugs` | the package folder, the repository issues | npm page links |
| `publishConfig` | `access: public`, `provenance: true` | Scoped packages are private by default; provenance ties each release to its commit and workflow |
| `engines.node` | the root's value (`>=24`), the Node version CI tests on | A package never claims support for a Node version nothing tests |
| `files` | everything published, and nothing else | The pack snapshot shows every change to this list |
| `pi` | `extensions` (and `skills`, `prompts`, `themes`), optional `image`, `video` | pi loads these entries; the gallery shows the image or video |
| `peerDependencies` | pi's packages as `"*"` | pi supplies them at runtime; a second copy breaks `instanceof` checks and typebox schemas |
| `dependencies` | exact versions, as few as possible | Users install them; exact versions are reproducible |
| `devDependencies` | none; use the root | Every package tests against the same pi and tooling versions |

## Source

- pi loads `src/index.ts` through jiti, so packages ship TypeScript. Anything Node runs directly from `node_modules` (a `bin`) must be JavaScript, or load the TypeScript through jiti: Node will not strip types under `node_modules`. `npm run smoke:pack` catches this.
- Only erasable TypeScript syntax (`erasableSyntaxOnly`): no enums, namespaces or parameter properties, so Node's type stripping and jiti read the same code.
- Relative imports include the `.ts` extension. Node built-ins use `node:`.
