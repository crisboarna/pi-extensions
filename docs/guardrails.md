# Guardrails

Every gate in this repository, where it runs, and the failure it prevents. A gate that fails prints the problem and how to fix it. No gate may be weakened to make a change pass (see `AGENTS.md`).

Where: **C** pre-commit hook, **M** commit-msg hook, **P** pre-push hook, **CI** `verify.yml` (run by `pr.yml` for pull requests and `main.yml` for pushes to `main`), **PR** pull requests only, **R** the publish jobs in `main.yml`, which run only after verification passes, **D** on demand, run by hand when a change touches what it covers (`AGENTS.md`, Definition of done), **N** the nightly run (`nightly.yml`), once a day against `main`.

Tools that are not npm packages of this repository (knip, gitleaks, actionlint, zizmor) run from Docker images pinned by digest (`scripts/tools/`, `tools/docker/`), so they give the same result on every machine and in CI. Docker must be running for the full check.

## Code

| Gate | Where | Prevents |
|---|---|---|
| Biome lint and format (`biome check --error-on-warnings`) | C P CI | Inconsistent formatting, unused imports and variables, `any`, non-null assertions, assignments in expressions, missing `node:` prefixes |
| Cognitive complexity (Biome, max 25) | C P CI | Functions too tangled to review. Files that were already over the limit have a per-file ceiling in `biome.json` that may only go down |
| TypeScript strict (`tsc -p tsconfig.json`) | C P CI | Type errors, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noUnused*` and `erasableSyntaxOnly` on, across packages, tests and scripts |
| File-size ratchet (`scripts/checks/file-sizes.ts`) | C P CI | Files that grow without limit. New files have a cap; files already over it are listed in `scripts/file-size-baseline.json` and can grow by at most 10% |
| Dead code (knip, in Docker) | P CI | Unused files, exports, types, enum members and dependencies; unlisted dependencies and binaries; unresolved imports; duplicate exports. Only real entry points (extension entries, bins, executable scripts, tests) count as used |
| Import boundaries (`scripts/checks/imports.ts`) | C P CI | One package reaching into another by path, undeclared dependencies, unaliased typebox subpaths, deep imports into pi |
| Coverage of 90% lines, branches and functions | P CI | Untested changes. Unit and integration tests together; every source file is imported by a test so none escapes measurement. `scripts/checks/manifests.ts` refuses a threshold below 90 |
| Integration tests | P CI | Breakage that only shows when pi loads the extension through jiti |
| Tests on the oldest supported Node (`floor` job, Node 22.19.0) | CI | Code or tests that only work on newer Node, while `engines.node` claims older. `scripts/checks/manifests.ts` keeps this job's version equal to root `engines.node` |

## Packages

| Gate | Where | Prevents |
|---|---|---|
| Manifest contract (`scripts/checks/manifests.ts`) | C P CI | Missing npm and gallery metadata, wrong scope, no provenance, pi's packages declared as dependencies, a pi peer range other than `PI_PEER_RANGE`, a root pi pin outside that range, unpinned runtime dependencies, an `engines.node` floor that CI does not test |
| Copies stay identical (`scripts/checks/copies.ts`) | C P CI | A helper copied between packages (packages cannot import each other) fixed in one package and left stale in the others. Today: the virtual terminal of the `test/tui` suites. Add a path to the script only for a file that must stay byte for byte the same |
| Keystroke tests for every interactive source file (`scripts/checks/tui-coverage.ts`) | C P CI | A source file that calls `ui.custom`, `ui.select`, `ui.confirm`, `ui.input`, `ui.editor`, `setEditorComponent`, `registerShortcut`, `addAutocompleteProvider` or `onTerminalInput` with no `test/tui` test that presses its keys in real pi. Each such file must be named in a `// covers:` header of a `test/tui` test, and a header may only name a file that exists |
| Soak of the test suites (`scripts/soak.ts`, `npm run soak`; `--randomize` shakes the order too) | D N | Tests that pass alone and fail or hang beside other work: a run that fails, or does not exit within the timeout, shows up on your machine before it shows up in CI |
| Real third-party extensions (`scripts/coexist.ts`, `npm run coexist`) | D N | A package that works beside pi's example extensions and breaks beside the ones people install: pinned versions are installed outside the repository and loaded in both orders, and a pin younger than the repository's `min-release-age` is refused |
| Mutation canary (`scripts/mutation-canary.ts`, `npm run mutation-canary`) | D N | A test that cannot fail: each deliberate break listed in `scripts/mutations` must make its tests fail, and a break that does not is reported |
| README claims (`scripts/checks/readme.ts`, rules in `scripts/lib/readme-rules.ts`) | C P CI | A README that promises more than the manifests and CI back: more than 8 badges, a value typed into a badge address that goes stale, a Node floor or a pi range other than `engines.node` and `PI_PEER_RANGE`, or "pi 1.4 or later" with no upper bound |
| Licences (`scripts/checks/licenses.ts`) | C P CI | A runtime or dev dependency under a copyleft, unknown or missing licence in the MIT packages' install tree |
| Build-time tools stay in Docker | media renders | A copyleft licence reaching the repository. The media image (`tools/docker/media.Dockerfile`) may hold GPL tools, today espeak-ng inside Kokoro's phonemizer, because they run only there to render media and are never installed in the repository or shipped; what they produce (audio) is ours. Third-party media committed to the repository, such as the music bed, must need no attribution (CC0 or public domain) and is recorded with its source, as in `tools/media/audio/README.md` |
| Narration loudness (`tools/media/narration.mjs`) | media renders | A narrated video whose voice is too quiet or too loud: the render fails unless the voice track measures -16 ±1 LUFS |
| Pack contents (`scripts/checks/pack.ts`) | P CI | Publishing tests, secrets or local files, or silently adding or dropping files; and a file an entry point loads (following relative imports, lazy ones too) that the tarball does not hold, which passes every test run from the repository and fails for a user. The file list is a committed snapshot in `scripts/pack-snapshots/` |
| Release plan (`scripts/release/plan.ts`; the release pull request in `pr.yml`, and `release-dry-run.yml` by hand) | PR D | A release that cannot be taken back: a tag with no version on npm or a version with no tag (a release that stopped half way), a version that is not newer than npm's newest, or a package `npm publish --dry-run` refuses. It publishes and tags nothing |
| Tarball smoke (`scripts/smoke-pack.ts`) | CI R | A package that works from the repository but not once installed: TypeScript that Node will not strip under `node_modules`, files missing from `files`, undeclared imports |
| End to end in real pi (`npm run test:e2e`; account-guard's and context-refs's `npm run test:smoke`) | CI | A package that loads but fails once used: commands that throw, CLI paths that crash, messages that name the wrong cause or fix, a warning shown twice; prompts routed to the wrong tier, a failover or escalation that does not happen, a subagent task on the wrong tier; the two packages breaking each other. `test:e2e` runs the packages from their tarballs in the repository's pinned pi, with stand-in models and a stand-in classifier; the two `test:smoke` suites load each package's `src/index.ts` in that pi, so a file left out of `files` is caught by `smoke:pack`, not by them |
| Real pi at the declared range (`pi floor` and `pi latest` in `verify.yml`, `pi-compat.yml`, `npm run pi-host`) | CI | A package that works with the pi it was built on and not with the oldest or the newest it claims: the real-pi suites run with the bottom of `PI_PEER_RANGE` and the newest release inside it, and each lane records the version it tested |
| Real pi, newest release (`pi newest`: nightly, and advisory on pull requests) | N PR | A pi release that breaks the packages, found on its first day instead of when someone upgrades. It ignores `min-release-age` for pi's own packages only (`docs/conventions/dependencies.md`); a failure fails the nightly run and opens one issue, and is a warning on a pull request |
| macOS (`macos.yml`: `npm run test:integration` and `npm run smoke:pack` on `macos-15`) | push to `main`, PR when `src`, `test/support`, `test/tui`, `smoke-pack.ts` or the lockfile change | A package that works on Linux and not on a Mac: `/var` against `/private/var`, a case-insensitive file system, BSD `git` and `sed`, a slower runner against a fixed timeout. Not a required check, because a path-filtered check that does not run would block every other pull request |
| Classifier servers end to end (`E2E_SERVERS=docker` or `lmstudio` `npm run test:e2e`) | D | Classifier setup, detect and eval that pass against fakes but fail against a real Ollama, llama.cpp, LiteLLM or LM Studio: printed commands that do not work as printed, a context too large for memory, a second copy loaded, a config written wrong, guide commands that do not run, a score well below the guide's |
| Changeset per changed package (`changeset status`) | CI | A release that does not mention a change |

## Text and documentation

| Gate | Where | Prevents |
|---|---|---|
| Invisible and bidi characters (`scripts/checks/text.ts`) | C P CI | Zero-width spaces, form feeds and other bytes models sometimes emit, and "Trojan Source" bidi controls that make code read differently from how it runs |
| Denied words (`scripts/lib/denylist.ts`, in the text and commit-msg checks) | C M P CI | Names of employers, clients and their projects in a file or a commit message. The list holds only SHA-256 hashes, so the repository never contains what it blocks, and a hit is reported by hash prefix |
| Line endings and final newline | C P CI | CRLF files and missing final newlines |
| Agent context budget | C P CI | `AGENTS.md` growing until it crowds out the task (150 lines at the root, 80 per package); `CLAUDE.md` drifting from `AGENTS.md` (it must contain only `@AGENTS.md`) |
| Markdown lint (`markdownlint-cli2`) | P CI | Broken tables, unlabelled code blocks, heading mistakes |
| Relative links and anchors (`scripts/checks/links.ts`), in the Markdown and in the family site it builds (`tools/site/build.ts`) | C P CI | Links broken by moving or renaming a doc, and site pages that point at nothing |

## Commits and pull requests

| Gate | Where | Prevents |
|---|---|---|
| Conventional Commits (`scripts/checks/commit-msg.ts`) | M CI | Unreadable history and changelogs; scopes that name no package |
| No AI attribution trailers | M CI | "Co-Authored-By" lines naming an assistant, and "Generated with" lines |
| Pull request template | PR | Changes merged without saying how they were verified |
| CODEOWNERS | PR | Changes merged without the owner's review (with the branch ruleset, see `docs/repository-settings.md`) |
| Signed commits (`scripts/checks/signatures.ts`) | P | Pushing commits without a valid signature from a key in `.github/allowed_signers`. It checks the commits that exist on no remote, so merging `main` into a branch does not ask for signatures on `main`'s own commits, which GitHub signs with its key. `test/signatures.test.ts` runs it against a fixture with real SSH-signed commits |
| GitHub-verified commits (`scripts/checks/github-signatures.ts`) | PR, `main` | Any commit in a pull request or push that GitHub does not show as Verified; the branch ruleset also requires signed commits |

## Supply chain

| Gate | Where | Prevents |
|---|---|---|
| `strict-allow-scripts` and `allowScripts` | every install | Dependency install scripts running unless allowed by name in `package.json` |
| `min-release-age=3` | every install | Installing a version published less than 3 days ago, when most malicious releases are still live |
| `save-exact`, `engine-strict` | every install | Floating versions; installing on an unsupported Node |
| Lockfile policy (`scripts/checks/npm-policy.ts`) | P CI | Dependencies resolved from anywhere but the npm registry, or without a sha512 hash; the `.npmrc` guards being removed |
| `npm audit signatures` | CI | Installed packages whose registry signatures or provenance attestations do not verify |
| `npm audit` on runtime dependencies (`scripts/tools/audit.ts`) | CI | A known vulnerability of moderate severity or worse in what users install, unless `audit-exceptions.json` lists that advisory and package with a reason and an expiry date |
| Dependency review | CI (PR), public repository only | New dependencies with known vulnerabilities or licences outside the allow-list |
| Dependabot with a 7-day cooldown | weekly | Stale dependencies and actions, without jumping on brand-new releases |
| gitleaks (in Docker) | C (staged changes) P CI (whole history) | Committed secrets. Deliberate fakes in tests are allow-listed narrowly in `.gitleaks.toml` |
| actionlint and zizmor (pedantic), in Docker | P CI | Broken workflows and workflow security mistakes (template injection, excessive or undocumented permissions, credential persistence, cache poisoning, impostor commits when online) |
| Actions pinned to full commit SHAs | CI | A moved tag changing the code a workflow runs |
| `permissions: {}` by default, per-job grants | CI R | Workflows holding more token scope than a job needs |
| CodeQL (`security-and-quality`) | CI weekly, public repository only | Common vulnerability patterns in TypeScript and in the workflows |
| OpenSSF Scorecard | weekly (public repository) | Regressions in repository security practices |
| Caches (npm, tool images, knip analysis) | CI | Slow runs. Tool images are keyed by their pinned digests; the publish jobs use no caches, so a poisoned cache cannot reach a release |
| Trusted publishing with provenance | R | Long-lived npm tokens; packages that cannot be traced to the commit and workflow that built them |
| Protected `npm` environment | R | Publishing without the owner's approval |

## Sources

The gates draw on these repositories, read on 2026-10-26: [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) (supply-chain `.npmrc`, Changesets with packed publishing, boundary checks, `AGENTS.md` rules), [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) (README standard, host-provided dependency check, file-size ratchet, coverage thresholds), [kaushikgopal/pi-kaush](https://github.com/kaushikgopal/pi-kaush) (trusted publishing, strict compiler flags, pack content check, context budget), [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages) (invisible-character lint, dead-code and boundary analysis, commit grammar), plus GitHub's and npm's own guidance on trusted publishing, Dependabot cooldowns and workflow hardening.
