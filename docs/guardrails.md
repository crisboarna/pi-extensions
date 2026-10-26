# Guardrails

Every gate in this repository, where it runs, and the failure it prevents. A gate that fails prints the problem and how to fix it. No gate may be weakened to make a change pass (see `AGENTS.md`).

Where: **C** pre-commit hook, **M** commit-msg hook, **P** pre-push hook, **CI** pull requests and `main`, **R** release workflow.

## Code

| Gate | Where | Prevents |
|---|---|---|
| Biome lint and format (`biome check --error-on-warnings`) | C P CI | Inconsistent formatting, unused imports and variables, `any`, non-null assertions, assignments in expressions, missing `node:` prefixes |
| Cognitive complexity (Biome, max 25) | C P CI | Functions too tangled to review. Files that were already over the limit have a per-file ceiling in `biome.json` that may only go down |
| TypeScript strict (`tsc -p tsconfig.json`) | C P CI | Type errors, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noUnused*` and `erasableSyntaxOnly` on, across packages, tests and scripts |
| File-size ratchet (`scripts/checks/file-sizes.ts`) | C P CI | Files that grow without limit. New files have a cap; files already over it are listed in `scripts/file-size-baseline.json` and can grow by at most 10% |
| Dead code (`knip`) | P CI | Unused files, exports, types and dependencies |
| Import boundaries (`scripts/checks/imports.ts`) | C P CI | One package reaching into another by path, undeclared dependencies, unaliased typebox subpaths, deep imports into pi |
| Unit tests with coverage thresholds | P CI | Untested changes. Thresholds sit just below today's coverage and only move up |
| Integration tests | P CI | Breakage that only shows when pi loads the extension through jiti |

## Packages

| Gate | Where | Prevents |
|---|---|---|
| Manifest contract (`scripts/checks/manifests.ts`) | C P CI | Missing npm and gallery metadata, wrong scope, no provenance, pi's packages declared as dependencies, unpinned runtime dependencies |
| Pack contents (`scripts/checks/pack.ts`) | P CI | Publishing tests, secrets or local files, or silently adding or dropping files. The file list is a committed snapshot in `scripts/pack-snapshots/` |
| Tarball smoke (`scripts/smoke-pack.ts`) | CI R | A package that works from the repository but not once installed: TypeScript that Node will not strip under `node_modules`, files missing from `files`, undeclared imports |
| Changeset per changed package (`changeset status`) | CI | A release that does not mention a change |

## Text and documentation

| Gate | Where | Prevents |
|---|---|---|
| Invisible and bidi characters (`scripts/checks/text.ts`) | C P CI | Zero-width spaces, form feeds and other bytes models sometimes emit, and "Trojan Source" bidi controls that make code read differently from how it runs |
| Line endings and final newline | C P CI | CRLF files and missing final newlines |
| Agent context budget | C P CI | `AGENTS.md` growing until it crowds out the task (150 lines at the root, 80 per package); `CLAUDE.md` drifting from `AGENTS.md` (it must contain only `@AGENTS.md`) |
| Markdown lint (`markdownlint-cli2`) | P CI | Broken tables, unlabelled code blocks, heading mistakes |
| Relative links and anchors (`scripts/checks/links.ts`) | C P CI | Links broken by moving or renaming a doc |

## Commits and pull requests

| Gate | Where | Prevents |
|---|---|---|
| Conventional Commits (`scripts/checks/commit-msg.ts`) | M CI | Unreadable history and changelogs; scopes that name no package |
| No AI attribution trailers | M CI | "Co-Authored-By" lines naming an assistant, and "Generated with" lines |
| Pull request template | PR | Changes merged without saying how they were verified |
| CODEOWNERS | PR | Changes merged without the owner's review (with the branch ruleset, see `docs/repository-settings.md`) |

## Supply chain

| Gate | Where | Prevents |
|---|---|---|
| `strict-allow-scripts` and `allowScripts` | every install | Dependency install scripts running unless allowed by name in `package.json` |
| `min-release-age=3` | every install | Installing a version published less than 3 days ago, when most malicious releases are still live |
| `save-exact`, `engine-strict` | every install | Floating versions; installing on an unsupported Node |
| Lockfile policy (`scripts/checks/npm-policy.ts`) | P CI | Dependencies resolved from anywhere but the npm registry, or without a sha512 hash; the `.npmrc` guards being removed |
| `npm audit signatures` | CI | Installed packages whose registry signatures or provenance attestations do not verify |
| `npm audit` on runtime dependencies | CI | Known vulnerabilities in what users install |
| Dependency review | CI (PR) | New dependencies with known vulnerabilities or licences outside the allow-list |
| Dependabot with a 7-day cooldown | weekly | Stale dependencies and actions, without jumping on brand-new releases |
| gitleaks | C (when installed) CI | Committed secrets |
| actionlint and zizmor (pedantic) | CI | Broken workflows and workflow security mistakes (template injection, excessive permissions, credential persistence, cache poisoning) |
| Actions pinned to full commit SHAs | CI | A moved tag changing the code a workflow runs |
| `permissions: {}` by default, per-job grants | CI R | Workflows holding more token scope than a job needs |
| CodeQL (`security-and-quality`) | CI weekly | Common vulnerability patterns in TypeScript and in the workflows |
| OpenSSF Scorecard | weekly (public repository) | Regressions in repository security practices |
| Trusted publishing with provenance | R | Long-lived npm tokens; packages that cannot be traced to the commit and workflow that built them |
| Protected `npm` environment | R | Publishing without the owner's approval |

## Sources

The gates draw on these repositories, read on 2026-10-26: [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) (supply-chain `.npmrc`, Changesets with packed publishing, boundary checks, `AGENTS.md` rules), [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) (README standard, host-provided dependency check, file-size ratchet, coverage thresholds), [kaushikgopal/pi-kaush](https://github.com/kaushikgopal/pi-kaush) (trusted publishing, strict compiler flags, pack content check, context budget), [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages) (invisible-character lint, dead-code and boundary analysis, commit grammar), plus GitHub's and npm's own guidance on trusted publishing, Dependabot cooldowns and workflow hardening.
