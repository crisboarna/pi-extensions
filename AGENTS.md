# Repository guidelines

Monorepo of independently published [pi](https://pi.dev) extension packages under the `@crisboarna` npm scope. Each rule below is enforced by a gate or checked in review; `docs/guardrails.md` lists every gate and why it exists.

## Layout

- Publishable packages live in `packages/<name>/`, published as `@crisboarna/<name>`, with source in `src/`, tests in `test/`, and their own `README.md`, `LICENSE`, `AGENTS.md` and `CHANGELOG.md`.
- Repository tooling lives in `scripts/` (TypeScript run directly by Node), its tests in `test/`, and conventions in `docs/conventions/`.
- Read the package's own `AGENTS.md` before changing a package; it overrides nothing here, it adds to it.
- Create a new package with `npm run new-package -- <name> "<description>"`, never by copying another package.

## Commands

- Run every command from the repository root unless a doc says otherwise.
- `npm install` installs everything; the `.npmrc` refuses dependency install scripts not allowed in `package.json` `allowScripts` and versions younger than 3 days.
- `npm run check` runs every repository gate (manifests, imports, text, file sizes, links, Biome, types, Markdown, knip, gitleaks, actionlint, zizmor, npm policy, pack contents) and reports all failures at once; knip, gitleaks, actionlint and zizmor run in Docker, which must be running.
- `npm run check:fast` runs the gates the pre-commit hook runs.
- `npm test` runs every package's unit tests and the repository script tests; `npm run test:integration` and `npm run coverage` run the rest of what CI runs.
- `npm run smoke:pack` installs each package from its packed tarball and loads it through jiti, the way users get it.
- `npm run format` applies Biome formatting and safe fixes; Markdown is linted by markdownlint, never formatted by Biome.

## Definition of done

- A change is done when `npm run check`, `npm test`, `npm run test:integration` and `npm run coverage` pass, and you have read their output.
- Add or update tests in the same change as the behaviour; a bug fix starts with a test that fails without the fix.
- Coverage stays at 90% or more for lines, branches and functions in every package (`npm run coverage`); cover new code with tests that assert behaviour, not with tests that only execute lines.
- After changing how a package loads, its `files`, `bin` or `pi` manifest entries, run `npm run smoke:pack` and `node scripts/checks/pack.ts`.
- After changing runtime behaviour, smoke it in a real pi: `pi -ne -e ./packages/<name>/src/index.ts`, with `PI_CODING_AGENT_DIR` pointing at a temporary directory.
- Say in the handoff which checks ran, which live checks ran, and what remains unverified.

## Guardrails are not negotiable

- Never weaken a gate to make it pass: no disabled rules, raised thresholds, wider baselines, skipped tests or `--no-verify` unless the user asks for that change.
- When a gate's baseline must move (file sizes, complexity overrides, coverage, pack snapshots), do it in its own reviewed diff and say why in the commit body.
- A `biome-ignore` or `@ts-expect-error` needs a reason after the colon that a reviewer can check.
- Do not use `any`, non-null assertions (`!`) or `as unknown as` casts in package source; narrow with checks instead.
- Do not add a dependency for something Node, pi or a few lines of code already do; runtime dependencies are pinned to an exact version.
- Never run `npm audit fix --force` or edit `node_modules`.

## Package boundaries

- Every package must install and work on its own; never import another package by relative path, and never depend on another extension's private files or state.
- Packages may cooperate only through documented, versioned events or APIs that degrade to standalone behaviour when the other side is absent.
- Pi's own packages (`@earendil-works/*`, `typebox`) are `"*"` peer dependencies, never dependencies; pi supplies them at runtime.
- Import typebox only as `typebox`, `typebox/value` or `typebox/compile`; pi does not alias other subpaths.
- Node built-ins use the `node:` prefix, and relative imports name the file with its extension.
- Keep `src/index.ts` to registration and wiring, and put behaviour in named modules that tests can import.

## Pi runtime rules

- Do not call pi action methods (models, thinking level, UI) while the extension factory loads; wait for `session_start` or later.
- Keep extension state out of the model's context: use custom session entries, tool-result `details` or files under the agent directory.
- Do not change the system prompt, active tool list or earlier messages mid-session; prompt-cache misses cost users money.
- Treat model ids, session text, file paths and tool output as untrusted input; strip terminal control characters before rendering.
- Release every timer, listener and child process on `session_shutdown`, and re-check session state after every `await` that can outlive it.
- Tests set `PI_CODING_AGENT_DIR` to a temporary directory before importing an extension and never read or write the real `~/.pi`.
- Never read `auth.json` or other credential files.

## Documentation

- Follow `docs/conventions/readme.md` for package READMEs: what it is, install, quick start, what you get, configuration, reference.
- Write documentation in plain, direct English: short sentences, active voice, one term for one thing.
- Put long-lived design in the package's `DESIGN.md`, decisions in `docs/adr/`, and terms in `GLOSSARY.md`; do not put plan or phase numbers in code comments.
- Update the README in the same change when a user would notice the difference.

## Git

- Commit messages follow `<type>(<scope>): <subject>` (`docs/conventions/commits.md`); the scope is a package folder name or `repo`, `deps`, `release`, `ci`, `docs`, `scripts`.
- Keep each commit to one intent and stage only the paths you mean to commit.
- Every commit is signed (`commit.gpgsign`); never pass `--no-gpg-sign` or push unsigned commits.
- Do not add AI attribution trailers or lines ("Co-Authored-By", "Generated with") to commits or pull requests; the commit-msg hook rejects them.
- Add a changeset (`npm run changeset`) when a change alters what a package publishes; tests, docs and tooling-only changes do not need one.
- Never push, publish, tag, create releases, change repository settings or change npm visibility without the user's explicit approval for that action.
