# Dependencies

## Adding one

1. Check whether Node, pi's API or a few lines of code already do it. Most packages here have no runtime dependencies.
2. Runtime dependency of a package: `npm install --workspace @crisboarna/<name> <dep>@<exact-version>`. Tooling: add it to the root `devDependencies`.
3. If npm reports `ESTRICTALLOWSCRIPTS`, decide whether the install script is needed. Allow it by name and version in the root `package.json` `allowScripts` only if it is; otherwise deny it (`false`).
4. A version younger than 3 days is refused (`min-release-age`). Use the newest older version, or wait.

## Policy

- `.npmrc` holds the install guards: `strict-allow-scripts`, `min-release-age=3`, `save-exact`, `engine-strict`. `scripts/checks/npm-policy.ts` fails if any is removed.
- Every lockfile entry must resolve from `https://registry.npmjs.org/` with a sha512 integrity hash.
- pi's packages (`@earendil-works/*`, `typebox`) are pinned in the root `devDependencies` to the pi release the packages are tested against, and declared as `"*"` peers in each package.
- Dependabot proposes updates weekly, after a 7-day cooldown. Review the changelog of anything that reaches users before merging.
- Known vulnerabilities in dev-only packages that come from pi itself are fixed by updating pi, not with `overrides`, unless an advisory affects this repository's tooling directly.
- Never run `npm audit fix --force`.

## Licences

Every package here is MIT. Every dependency in `package-lock.json`, runtime or dev, must be under a permissive licence: MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak, CC0, Unlicense or the Python licences. `scripts/checks/licenses.ts` reads the licence npm recorded for each one and fails on anything else, including a missing licence.

Tools that are not npm dependencies are used only to build and check, and nothing from them is published: the Docker images (gitleaks, actionlint and zizmor are MIT, knip is ISC, Playwright is Apache-2.0, ffmpeg is LGPL or GPL), and the IBM Plex and JetBrains Mono fonts (SIL Open Font License), which only appear as rendered pixels in `media/`. Do not ship the font files or ffmpeg binaries in a package.
