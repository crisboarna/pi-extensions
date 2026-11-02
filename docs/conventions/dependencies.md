# Dependencies

## Adding one

1. Check whether Node, pi's API or a few lines of code already do it. Most packages here have no runtime dependencies.
2. Runtime dependency of a package: `npm install --workspace @crisboarna/<name> <dep>@<exact-version>`. Tooling: add it to the root `devDependencies`.
3. If npm reports `ESTRICTALLOWSCRIPTS`, decide whether the install script is needed. Allow it by name and version in the root `package.json` `allowScripts` only if it is; otherwise deny it (`false`).
4. A version younger than 3 days is refused (`min-release-age`). Use the newest older version, or wait.

## Policy

- `.npmrc` holds the install guards: `strict-allow-scripts`, `min-release-age=3`, `save-exact`, `engine-strict`. `scripts/checks/npm-policy.ts` fails if any is removed.
- Every lockfile entry must resolve from `https://registry.npmjs.org/` with a sha512 integrity hash.
- pi's packages (`@earendil-works/*`, `typebox`) are pinned in the root `devDependencies` to the pi release the packages are tested against. Each package declares them as peers: `@earendil-works/*` as `PI_PEER_RANGE` (`scripts/lib/repo.ts`, now `>=1.4.0 <2`), `typebox` as `"*"`. The manifests gate fails on any other value, and on a root pin outside the range.
- The range is a promise that CI tests it: `npm run pi-host -- floor` and `-- latest` put the bottom and the newest release of the range into `node_modules` so the suites run against both. A bounded range is safe because pi installs extensions with `--omit=peer` (or `--legacy-peer-deps`), so it never fetches a second copy of pi; only a plain `npm install` outside pi sees a peer warning, and that warning is the point.
- One lane deliberately skips the age rule: `pi newest` (the nightly run, and an advisory lane on pull requests) installs the newest pi release even when it is younger than `min-release-age`, because the point is to learn on the first day that a release breaks the packages. The exception covers pi's own four packages only, installed with `--ignore-scripts` into a CI checkout that holds no secrets and publishes nothing; every other dependency, and every other lane, keeps the rule. The age rule is applied by `scripts/pi-host.ts` itself, which refuses `newest` without `--allow-young`.
- To raise the floor or the ceiling, change `PI_PEER_RANGE`, the three manifests and the root pin together in one pull request, and add a changeset: the gate fails until they agree.
- Dependabot proposes updates weekly, after a 7-day cooldown. Review the changelog of anything that reaches users before merging.
- Known vulnerabilities in dev-only packages that come from pi itself are fixed by updating pi, not with `overrides`, unless an advisory affects this repository's tooling directly.
- Current exception: `overrides` pins `undici` to 8.12.3 because pi 1.4.0 pins 8.10.2, which has advisories GHSA-f72v-6w45-q472 and GHSA-xjj6-f33q-929c, and the runtime audit counts pi's packages. Remove the override once a pi release depends on `undici` 8.12.2 or later.
- Never run `npm audit fix --force`.

## Licences

Every package here is MIT. Every dependency in `package-lock.json`, runtime or dev, must be under a permissive licence: MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak, CC0, Unlicense or the Python licences. `scripts/checks/licenses.ts` reads the licence npm recorded for each one and fails on anything else, including a missing licence.

Tools that are not npm dependencies are used only to build and check, and nothing from them is published: the Docker images (gitleaks, actionlint and zizmor are MIT, knip is ISC, Playwright is Apache-2.0, ffmpeg is LGPL or GPL), and the IBM Plex and JetBrains Mono fonts (SIL Open Font License), which only appear as rendered pixels in `media/`. Do not ship the font files or ffmpeg binaries in a package.
