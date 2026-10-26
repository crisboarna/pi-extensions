# Presentation plan: pi-account-guard and the family site

Status: approved 2026-10-26. Step 0 (clean slate) done on 2026-10-26; the remaining work is tracked as tickets #90-#107 under "Spec: presentation for pi-account-guard and the family site" (#89).

Ground rules: nothing on this machine outside the pi-extensions clone is created, changed or deleted, and every check and recording runs in a simulated environment (demo homes, demo accounts, fake providers, no real account or user file).

## Context

`@crisboarna/pi-account-guard` joined the monorepo (PR #30). It stops a turn from going to a model account (provider id + auth source) whose zones do not include the zone of the directory pi works in. It fails closed, exits 77 when headless, and ships a block select, a tag-prompt checklist, a footer item, `/guard` commands and a JSON config with a schema.

It has none of what pi-switchboard now has: no mark, banner, cover, `pi.image` or `pi.video`; no animations or clips; a 199-line manual-style README; and the 8 TUI checks in `docs/manual-checklist.md` have never run. Goal: the same treatment, plus one site that presents both packages as a family, each with a live try-it.

Decisions (2026-10-26):

- **Brand:** family brand (switchboard's palette, IBM Plex, terminal style), own mark and accent for account-guard.
- **Site:** one GitHub Pages site for pi-extensions, a page per package.
- **Try it:** live pi in the browser (WebContainer) plus a static explainer that runs the real `src/core`.
- **Real names:** two employer names and one client project name appear in account-guard's examples, docs and tests. Purge them from every history, recreate the GitHub repository, delete the source repository `crisboarna/pi-account-guard`, and use fictional names only. This plan does not spell them out; the replacement map lived in a scratch folder inside the clone, deleted after use.

## Findings

| Area | Finding | Consequence |
|---|---|---|
| Competition | The npm survey (`keywords:pi-package` + account, guard, subscription, multi-pass, work personal) finds rotators that move between accounts (pi-multi-account 6.6k/month, pi-multiprovider 1.8k, pi-rotator 1.4k, pi-multi-pass 1.2k), Codex work/personal aliases (2.6k) and shell-command guards. None checks which account may run where. | Position as the safety net under rotators and routers: "rotate freely, never into the wrong zone". Compare by approach, not by name, as for switchboard. |
| README | Manual-style; misses Quick start and What you get from `docs/conventions/readme.md`; config, commands, footer and headless reference are inline. | Rewrite to the standard; move reference to `docs/`. |
| Real names | The names sit in the current `README.md`, `examples/account-guard.json`, `DESIGN.md`, `test/unit/place.test.ts` and `test/unit/remote.test.ts`: a note on an account, a path rule, a remote glob, an SSH host alias and a client repository name. In history: file contents of 13 commits across main and the import, port, prototype and research branches, plus 2 commit messages. The source repository holds them in 6 commits and 1 message. Copies outside pi-extensions (the original checkouts, worktrees, session files) are out of scope: nothing outside the pi-extensions clone is changed. GitHub's PR refs (#27–31, including the merges of #30 and #31) keep old commits reachable after a force-push. Neither package is on npm. | Step 0, before anything else. |
| Core | `src/core` imports only `node:path` (posix) besides itself; `test/unit/core-purity.test.ts` keeps it pi-free. | The static explainer can run the real core in the browser with an import map that shims `node:path`. |
| Git | The guard runs `git remote -v`; the media image has git 2.43; WebContainers have no git. | Scenes may use remote rules; the browser try-it uses path rules only (a remote rule there would fail closed). |
| Providers | `test/support/stub-provider.ts` and `second-provider.ts` give in-process providers; switchboard's `media/terminal/fake-llm.ts` gives a streaming HTTP provider with scripted replies and errors. | Scenes use the fake provider for realistic replies; accounts come from env-var keys (`env:ACME_WORK_KEY`), so no OAuth is needed. |
| Live checks | All eight manual-checklist items can run in simulated terminal scenes: 1–5 and 7 with the guard and pi-switchboard alone, 6 with pi-multi-pass, 8 with pi-claude-bridge (account resolution reads only variable names and the config directory, so fake values suffice). | Run them as scenes first, as with switchboard (eight bugs found there). Every check and every recording runs in the simulated environment: demo homes, demo accounts, fake providers; no real account, config or file of the user's. |

## Approach

### 0. Clean slate: purged names, one commit per ticket, a complete tracker

The repository is recreated, so main can start over: no real names anywhere, one signed commit per implementation ticket, and every commit tied to a ticket that explains why it exists. Irreversible actions (deleting either GitHub repository) each wait for their own explicit confirmation.

Decisions (2026-10-26): one commit per implementation ticket; the fine-grained history is dropped (only the squashed main and the wayfinder `research/*` and `prototype/*` branches remain, rewritten); retroactive tickets are created closed, with a resolution comment naming their commit; pi-account-guard's issues keep their numbers #1–26.

**0.1 Freeze and export.**

- No pushes or merges until 0.7 ends (PR #31 merged minutes before this plan). Close the three Dependabot PRs at the end; Dependabot reopens them on the new repository.
- Everything below works inside the pi-extensions clone only: a scratch folder `.git/purge/` (inside the repository directory, never tracked, deleted in 0.8) holds the export, the backup, the replacement map and the ledger. Nothing outside the clone is created, changed or deleted.
- Export what deletion loses into `.git/purge/`: issues #1–26 with bodies, comments (author, date, body), labels, state and close reason, assignees, sub-issue parents and blocked-by edges (GraphQL `subIssues`, `parent`, `blockedBy`, already queried successfully with `env -u GH_TOKEN`); PR #30 and #31 bodies (the import mapping); the label set (including `wayfinder:*` and `ready-for-agent`); rulesets, environments and Actions settings, checked against `docs/repository-settings.md`.
- A `git bundle` of every ref into `.git/purge/`, kept until 0.8.

**0.2 Replacement map.** A file in `.git/purge/`, never committed. The employer in paths, notes and SSH aliases becomes `acme` (`~/Projects/acme`, `Acme seat`, `github.com-acme`), the employer in remote globs `acme-corp`, the client repository `billing-portal`. Applied case-insensitively to file contents, commit messages, and the exported issue bodies and comments (they contain the names too), so a test's input and its expected output change together.

**0.3 Purged trees.** (Done with git plumbing instead of `git filter-repo`, so nothing was installed outside the clone: each needed snapshot was rewritten through a temporary index.) Run `git filter-repo` (through `pipx run`, not a repository dependency) in place in the pi-extensions clone (`--force`, after the bundle exists) with `--replace-text` and `--replace-message`. This gives the purged tree of every original commit, which 0.5 uses as snapshots, and the rewritten `research/pi-account-guard/*` and `prototype/pi-account-guard/block-ux` branches.

**0.4 Ticket ledger.** A file in `.git/purge/` (not committed) maps every original commit on main and on the imported pi-account-guard line to exactly one implementation ticket, with no gaps:

- **pi-account-guard:** decision tickets #2–13 under map #1; spec #14; implementation tickets #15–26, as they are today. Its import and hardening work (PRs #30 and #31) becomes follow-up tickets #27 and #28 under the spec.
- **Monorepo:** a spec, "Spec: pi-extensions monorepo", with tickets for the repository scaffold, the gates, CI and publishing, signed commits, the Docker tools, the Node floor and licence gate, and the media pipeline.
- **pi-switchboard:** written as `/wayfinder`, `/to-spec` and `/to-tickets` would have produced them, reconstructed from `DESIGN.md`, the ADRs, `docs/plans/`, the commit history and the earlier sessions: a map with its decision tickets and their resolutions, a spec (problem, solution, a long list of user stories, implementation and testing decisions, out of scope), implementation tickets as vertical slices with blocked-by edges, and follow-up tickets for the presentation work and the bugs the live checks found. Appendix A lists them for review.
- Numbering is fixed before anything is pushed: #1–26 as today, then the monorepo spec and tickets, then pi-switchboard's map, decisions, spec and tickets, then the open tickets for this plan (step 0.9).

**0.5 Build the new main.** One commit per implementation ticket, in the order the ranges landed (Appendix A, ledger rules), so each tree is the purged tree at the last original commit of its range; pi-account-guard's tickets come last, each laying its subtree onto main's tree at that point. Each commit has a Conventional Commit title, a body that summarises the ticket, `Closes #<n>`, the author's original name and email, author and committer dates set to the range's last original commit, and an SSH signature (`git commit-tree -S`). Only the tip is promised to pass today's gates; earlier snapshots are history. The tip's tree equals today's main with the replacements applied.

**0.6 Verify locally, before anything leaves the machine.**

- No ref holds a name from the map: `git log --all -p` and `git log --all --format=%B`, searched with the map.
- `scripts/checks/signatures.ts --range` passes for every commit, and every commit's `Closes #<n>` is in the ledger.
- At the tip of main: `npm run check`, the tests, coverage, `npm run smoke:pack`, and the Node 22.19.0 floor run all pass.
- The tip's tree equals the purged tree of today's main.

**0.7 Recreate on GitHub.** Only after explicit confirmation:

1. Delete `crisboarna/pi-extensions`, then create it again with the same name, private. It turns public when the user approves the first release; Pages, the README images and the gallery fields work only from then on.
2. Create the labels. Create the issues in ledger order, so the numbers match, with the replacements applied to every body and comment. Each body ends with an "Originally opened … closed …" line, because the API cannot set past dates.
3. Wire the sub-issues and the native blocked-by edges in a second pass.
4. Push main and the research and prototype branches.
5. Close every retroactive ticket with a resolution comment that links its commit.
6. Re-apply `docs/repository-settings.md`: rulesets, the `npm` environment, Actions may open pull requests, rebase merges off, and Pages from Actions.

**0.8 Source repository and clean-up inside the clone.** After its own explicit confirmation, delete the GitHub repository `crisboarna/pi-account-guard` (a remote action; its history lives on, rewritten, in pi-extensions). In the pi-extensions clone: point `origin` at the recreated remote, expire the reflog and `git gc --prune=now` so no old object remains, delete `.git/purge/`. Nothing outside the clone is touched: the original checkouts, worktrees and session files elsewhere on the machine stay as they are.

**0.9 Keep them out, and track what comes next.**

- `scripts/checks/text.ts` gains a denylist stored as SHA-256 hashes of lower-cased words, so the check never contains the names it blocks. Its fixtures use made-up words with known hashes. gitleaks gets no plain-text rule, for the same reason.
- This plan's remaining sections (1–7) become "Spec: presentation for pi-account-guard and the family site" and its open `ready-for-agent` tickets with blocked-by edges. The work then proceeds one ticket at a time, one commit each.

### 1. Front door

- README to the standard, about 120 lines. Lede: "Keeps each pi session on the accounts that belong where it runs: a work subscription never answers in a personal repository, and the other way round." What you get (6 bullets): fails closed; one-keystroke fix (Switch, Allow once, Allow for session); tags itself on first use; catches rotators and routers mid-turn; scripts see exit 77; reads no secrets.
- `docs/`: `configuration.md` (file, zones, accounts, place rules, schema), `blocks.md` (the select, the tag prompt, mid-turn), `commands.md` (every `/guard` command, with clips), `footer.md`, `headless.md` (exit 77, the process override, RPC), `with-other-extensions.md` (multi-pass, rotators, claude-bridge, switchboard, pools), `troubleshooting.md`, `faq.md`. Limits stay in the README.
- Mark and accent: same enamel tile and brass rim as switchboard; a keyed plug that fits only the jack of its own zone, with a lamp that is green on Match and red on Block. Banner (light, dark), cover, mark, rendered from `media/src/*.html` like switchboard's.
- `package.json`: `pi.image` (cover), `pi.video` (hero), keywords `work`, `personal`, `subscription`, `accounts`.

### 2. Live checks as terminal scenes (before any recording)

- `media/terminal/setup.ts` for account-guard: a throwaway home with `~/work/acme-api` (git remote `github.com/acme-corp/acme-api`) and `~/personal/garden-planner`; three demo accounts on env-var keys (`acme`, work; `homelab`, personal; `spare`, untagged); `account-guard.json` with one path rule and one remote rule.
- Scene `checks` runs manual-checklist items 1–5 and 7 (7 loads pi-switchboard from the repo) and saves a still per item; item 6 with pi-multi-pass and item 8 with pi-claude-bridge as root dev dependencies (licences vetted by `scripts/checks/licenses.ts`), each with fake keys and a demo `CLAUDE_CONFIG_DIR` inside the scene home. Every check and recording runs in this simulated environment; none uses a real account or anything from the user's machine.
- Fix what they find, with a failing test first; record results in `docs/manual-checklist.md`.

### 3. Concept animations (HTML, data from the real core)

`media/data.ts` runs `src/core` (decide, place, config) on scripted inputs, as switchboard's does:

1. **How a turn is checked:** account (provider + source) → its zones; directory and remotes → first matching place rule → place zone; Match lamp green, or Block with the reason.
2. **Place rules:** a list of path and remote rules, first match wins, a directory falls through to the default zone; editing the order changes the outcome.
3. **The safety net under rotators:** a rotator moves a running turn to the next account; that account is work, the place is personal; the guard aborts the turn and offers the previous account first.

### 4. Hero and clips (terminal scenes, reusing `tools/media`)

Hero, about 60 s, captions and callouts:

| Beat | Screen |
|---|---|
| Title | Mark, name, "Rotate freely. Never into the wrong zone." (pi starts off camera) |
| 1/5 | `~/personal/garden-planner` with the `acme` (work) account selected; a prompt; the BLOCKED select. Callouts: account zone, place zone. |
| 2/5 | Switch to `homelab`; the same prompt runs; footer `guard personal ✓`. |
| 3/5 | `/model spare`: the tag prompt checklist; tag `personal`; the turn goes at once. |
| 4/5 | A rotation mid-turn (`/model acme` while streaming) aborts with "failover blocked"; once idle the previous account is offered first. |
| 5/5 | `/guard`: the place, the rule that decided it, the account, its Match. |
| End | `pi install npm:@crisboarna/pi-account-guard`. |

Clips (MP4, GIF from the MP4, still): `block`, `tag`, `allow`, `mid-turn`, `guard-status`, `place-add` (`/guard place add here zone=work`), `headless` (a shell: `pi -p ...; echo $?` → 77, run with a shell as the scene's program), `with-switchboard` (`switchboard/auto` tagged as one account).

### 5. In-product

- `/guard check <path> [provider [source]]`: which rule decides that directory, its zone, and whether the current (or named) account would pass. Nothing is written. Same idea as `/tier try`.
- `/guard tour`: four steps with sample accounts and places; writes nothing.
- First-run notice (once, stored next to the config): accounts start untagged, the first turn asks which zones this account belongs to, `/guard` shows the place and the account.
- Bundled skill `skills/pi-account-guard/SKILL.md` (and `pi.skills`): explains a block in plain words, proposes `/guard tag` or `/guard place add` commands, reads `account-guard.json` and validates it against the schema, and never suggests `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN` or editing around a block.
- README "For agents and scripts": exit 77, stderr only, the RPC `notify`, and the skill.

### 6. Family site (GitHub Pages)

- `site/` at the root, built by `tools/site/build.ts` (TypeScript run by Node, like the other scripts): Markdown from each package's README and `docs/` rendered with `marked` (pinned, MIT); pages from small HTML templates; brand tokens shared with the media pages (move switchboard's `media/src/brand.css` palette to `tools/brand/tokens.css`, each package keeps its own mark and accent).
- Pages: a landing ("Extensions for pi: route every request, guard every account", both packages with poster, one-line pitch, install line); one page per package (hero video, What you get, clips, try-it, docs); `llms.txt` with the packages' docs for agents.
- Try-it, live: the WebContainer pattern from the spike (`/tmp/wc-lab`): prebuilt `node_modules` snapshot built in `node:22-slim` and pruned to what pi needs, gzipped and unpacked with `DecompressionStream`, fd/rg stubs, xterm.js with the fit addon, `coi-serviceworker` for Pages. account-guard: a shell (`jsh`) in a home with the two repositories and buttons that type `cd ~/personal/garden-planner && pi --model acme/work-model` and similar, so the visitor sees the real block, tag prompt and exit 77. switchboard: the same pi session with the scripted classifier and providers from `media/terminal/scenes/demo.ts`.
- Try-it, static: account-guard's config tester (paste or edit `account-guard.json`, a directory and its remotes, an account → the deciding rule, the zone, Match or Block) runs `src/core` compiled to browser modules by `tsc` (`rewriteRelativeImportExtensions`), no bundler. switchboard's rule playground (its plan section 4.7) uses the same build for `src/rules` and `src/tiering`.
- Deploy: `.github/workflows/pages.yml` on main after `verify`, actions pinned by SHA, `pages: write` and `id-token: write` only in that job.

### 7. Shared tooling

- Move `fake-llm.ts` (and the scene home helpers) from `packages/pi-switchboard/media/terminal/` to `tools/media/terminal-kit/`, so both packages' scenes and the site's try-it use one copy.
- The snapshot builder becomes `tools/site/snapshot.ts`, run in Docker with network (it installs from npm), with a smoke check that the snapshot starts pi and loads the extension.

## Files to change

- `packages/pi-account-guard/`: `README.md`, new `docs/*.md`, `examples/account-guard.json`, `DESIGN.md`, `test/unit/place.test.ts` (names), `package.json` (`pi.image`, `pi.video`, `pi.skills`, keywords, `files` + `skills`), new `media/` (manifest, `src/`, `terminal/`, `data.ts`), new `skills/`, `src/core/` and `src/pi/` (check, tour, first-run notice), tests for each.
- Root: `tools/media/terminal-kit/` (moved code), `tools/brand/tokens.css`, `tools/site/` (build, snapshot), `site/` templates, `.github/workflows/pages.yml`, `package.json` (dev deps: pi-multi-pass, marked, @webcontainer/snapshot, @webcontainer/api, @xterm/xterm, @xterm/addon-fit, coi-serviceworker), `knip.json`, `tsconfig.json`, `README.md` (family banner, site link), `docs/guardrails.md`.
- `packages/pi-switchboard/`: media pages import the shared tokens; scenes import the shared kit; its site page.

## Reuse

- `tools/media/render.mjs` (png, animation, terminal kinds, `window.prepare`), `tools/media/stage-server.mjs`, `tools/media/run-in-pty.py`, `tools/media/stage/stage.js` (Stage API: `type`, `press`, `command`, `waitFor`, anchored `callout`, `caption`, `card`, `still`).
- `packages/pi-switchboard/media/terminal/setup.ts` and `fake-llm.ts` (scene home, demo providers, `MEDIA_KEEP`), `media/src/clip.js`, `terminal.css`.
- `packages/pi-switchboard/media/data.ts` (real engine driving animation data) as the model for account-guard's `data.ts`.
- `packages/pi-account-guard/test/support/stub-provider.ts`, `second-provider.ts`, `fake-pi.ts` (tests for the new commands).
- `scripts/smoke-pack.ts` (real pi loading the tarball) and `scripts/checks/licenses.ts` for the new dependencies.
- The WebContainer spike in `/tmp/wc-lab` (`tui.html`, `snap.mjs`, `measure.mjs`, `server.mjs`).

## Steps

- [x] 0.1–0.4: freeze, export issues and settings, bundle, local replacement map, `git filter-repo`, ticket ledger (Appendix A approved first).
- [x] 0.5–0.6: squashed, signed main (one commit per implementation ticket, `Closes #<n>`); local verification.
- [x] 0.7: after confirmation, recreate `crisboarna/pi-extensions`; labels, issues in ledger order with replacements, sub-issues and blocked-by edges, push, resolution comments, settings.
- [x] 0.8: after confirmation, delete the GitHub repository `crisboarna/pi-account-guard`; in the clone, point `origin` at the new remote, expire the reflog, `git gc --prune=now`, delete `.git/purge/`.
- [ ] 0.9: hashed denylist in `scripts/checks/text.ts`; publish this plan's spec and open tickets (Appendix B); then every step below is one ticket, one commit.
- [ ] account-guard scene setup and the `checks` scene; run manual-checklist items 1–7; fix findings test-first; fill in the checklist.
- [ ] Shared tooling: terminal kit and brand tokens moved to `tools/`; switchboard media still renders unchanged.
- [ ] Mark, banner (light, dark), cover; `pi.image`.
- [ ] README rewrite and `docs/` pages; links and markdownlint pass.
- [ ] `media/data.ts` and the three concept animations.
- [ ] Hero (`pi.video`) and the eight clips; embed in README and docs.
- [ ] `/guard check`, `/guard tour`, first-run notice, bundled skill, with unit and integration tests; changeset.
- [ ] Site build (landing, package pages, docs, `llms.txt`), shared templates; static explainers for both packages.
- [ ] WebContainer snapshots for both packages and the try-it pages; measured load time and transfer.
- [ ] `pages.yml`; update `docs/repository-settings.md` (enable Pages from Actions).
- [ ] Root README family banner and site link; plan status updated in both packages.

## Verification

- Clean slate, on a fresh clone of the recreated remote: no commit content, message, ref, issue body or comment holds a name from the local map (`git log --all -p`, `git log --all --format=%B`, `gh issue list --state all --json body,comments` searched with the map); main has one commit per implementation ticket, each signed (Verified on GitHub) and closing exactly the ticket the ledger names; issues #1–26 match the export (titles, labels, state, sub-issues, blocked-by), and every retroactive ticket is closed with a comment linking its commit; the denylist check fails on a fixture that contains a denied word.
- `npm run check`, `npm run coverage` (90/90/90 per package), `npm run test:integration`, `npm run test:repo`, `npm run smoke:pack` (real pi loads both tarballs), the floor job's tests on Node 22.19.0, and account-guard's `test:smoke`.
- `npm run media` in each package renders every asset; stills reviewed frame by frame; every GIF under 1 MB.
- `docs/manual-checklist.md` has a result for all eight items, each from a simulated scene with its still.
- Site: `tools/site/build.ts` builds without warnings; the links check covers `site/`; a Playwright run in the media image opens every page, plays the hero, runs the static explainer on the README example (the deciding rule and zone match what `/guard check` prints for the same input), and boots each WebContainer try-it in Chromium, Firefox and WebKit to a ready prompt (time to prompt and bytes recorded).
- Licences: the new dev dependencies pass `scripts/checks/licenses.ts`.

## Appendix B: open tickets for this plan (proposed `/to-tickets` breakdown)

Published in 0.9 under "Spec: presentation for pi-account-guard and the family site" (sections 1–7 above, in the `/to-spec` template), labelled `ready-for-agent`, with native blocked-by edges. Each ticket is one commit.

| # | Ticket | Blocked by | Delivers |
|---|---|---|---|
| B1 | Keep denied names out with a hashed denylist | none | `scripts/checks/text.ts` fails on a denied word without storing it; fixtures with made-up words. |
| B2 | Share the terminal kit and brand tokens | none | `fake-llm` and scene home helpers in `tools/media/terminal-kit/`, palette in `tools/brand/tokens.css`; pi-switchboard's media render unchanged. |
| B3 | Run the account-guard TUI checks as scenes | B2 | Scene home (two repositories, three accounts), `checks` scene for checklist items 1–5 and 7, stills, results in `docs/manual-checklist.md`; a follow-up ticket per bug found. |
| B4 | Check pi-multi-pass rotation live | B3 | pi-multi-pass as a dev dependency; checklist item 6 run as a scene. |
| B5 | Give pi-account-guard its mark, banner and cover | B2 | Mark, banner (light, dark), cover from `media/src`; `pi.image`. |
| B6 | Rewrite the account-guard README and split its reference into docs | B5 | README to `docs/conventions/readme.md`; the eight `docs/` pages; links and markdownlint pass. |
| B7 | Add `/guard check` | none | Which rule decides a directory, its zone, and whether an account passes; nothing written; unit and integration tests. |
| B8 | Add `/guard tour` and the first-run notice | none | Four-step tour that writes nothing; one-time notice; tests. |
| B9 | Bundle the account-guard skill and document use by agents and scripts | B7 | `skills/pi-account-guard`, `pi.skills`, README "For agents and scripts". |
| B10 | Animate how a turn is checked, place rules, and the safety net under rotators | B2, B5 | `media/data.ts` on the real core; three animations (MP4, GIF, still). |
| B11 | Record the account-guard hero | B3, B5 | 60 s hero from real sessions; `pi.video`; poster in the README. |
| B12 | Record the account-guard clips | B3, B6, B7 | Eight clips embedded in the README and `docs/`. |
| B13 | Build the family site | B2, B6 | `tools/site/build.ts`; landing, a page per package, docs rendered, `llms.txt`; links check covers `site/`. |
| B14 | Add the static explainers | B13 | account-guard's config tester and pi-switchboard's rule playground on the real core compiled by `tsc`; parity test against `/guard check` and `/tier try`. |
| B15 | Try pi-account-guard live in the browser | B13 | Snapshot builder, account-guard try-it page; time to prompt and bytes measured in three browsers. |
| B16 | Try pi-switchboard live in the browser | B15 | The same for pi-switchboard with the scripted classifier and providers. |
| B17 | Deploy the site to GitHub Pages | B13 | `pages.yml` after `verify`; `docs/repository-settings.md` updated. |
| B18 | Present both packages as one family | B11, B17 | Root README banner and site link; both plans' status updated. |

## Outcome of step 0

- Main rebuilt as 48 signed commits, one per implementation ticket, each closing it; tip tree equal to the old main with the names replaced; every gate, test, coverage run, the tarball smoke test and the Node 22.19.0 floor passed before the push.
- `crisboarna/pi-extensions` recreated private with 107 issues (88 closed with resolution comments and commit links, 19 open), sub-issues and blocked-by edges matching the plan; the five research and prototype branches kept as one commit each on the design commit.
- `crisboarna/pi-account-guard` deleted. Branch rulesets and the `npm` environment wait for the public flip (GitHub refuses them on a private repository on this plan).
- Locally, one worktree outside the clone still has the old hardening branch checked out, so its objects stay in the local object store; nothing outside the clone was changed.

## Appendix A: retroactive tickets and the ledger (proposed `/wayfinder`, `/to-spec`, `/to-tickets` breakdown)

Source: an inventory of the 74 first-parent commits on main (checked against git: root `388562f`, tip `6a866e6`), the original checkout's `DESIGN.md` (§16 decision log, §19 build notes), its three ADRs, `docs/plans/`, the monorepo's ADR and guardrail sources, and the user prompts of the earlier sessions (2026-10-24 to 10-26). Ticket bodies follow the skills' templates; every retroactive ticket is closed with a resolution comment naming its squashed commit. Numbers are fixed in this order.

### pi-account-guard (#1–28)

- #1–26 as exported: map #1 with decisions #2–13, spec #14, implementation tickets #15–26 (sub-issues and blocked-by edges unchanged; names replaced in bodies and comments).
- #27 **Harden after review and import pi-account-guard into the monorepo** (sub-issue of #14, blocked by #26; it also took the 11 review fixes and refactors that landed between #26 and the import): the PR #30 line, including its two root commits (gate-fixture git isolation, the undici override). One squashed commit.
- #28 **Port the pi-account-guard hardening** (sub-issue of #14, blocked by #27): the PR #31 line, including the root commit that runs dependency review and CodeQL only while public. One squashed commit.
- The ledger maps every commit on the imported line to exactly one of #15–28; the imported history-import map (commit `e8dbc66`) is its starting point.

### Monorepo (#29–37)

Issue #29, **Spec: pi-extensions monorepo** (`/to-spec` template: problem, solution, user stories for package authors, agents and users installing from npm, implementation and testing decisions, out of scope), with these tickets as sub-issues:

| # | Ticket | Blocked by | Range on main (count) |
|---|---|---|---|
| 30 | Create the workspace monorepo and publish `@crisboarna/pi-switchboard` from it | #79 | `8340c84..738d3fb` (4) |
| 31 | Add the repository gates, tarball smoke test, package scaffold, git hooks and Changesets | #30 | `42f0aad..9274fd5` (2) |
| 32 | Add the first CI, security, CodeQL, Scorecard and release workflows | #31 | `3c59c12` (1) |
| 33 | Write the agent rules, guardrail catalogue, conventions and release guide; make the scaffold pass the gates | #31 | `580f497..fea520c` (3) |
| 34 | Run the Docker tools, verify before publish, require signed commits and the 90% floor | #32, #33 | `a904095..53dab26` (5) |
| 35 | Raise pi-switchboard to 90% line, branch and function coverage | #34 | `ff4ff5d..9dab571` (8) |
| 36 | Require Node 24 (superseded by #37) | #34 | `5c7d255` (1) |
| 37 | Support Node 22.19, test it in CI, and allow only permissive licences | #36, #59 | `684fe6e` (1) |

### pi-switchboard: map and decisions (#38–61)

Issue #38, **Map: design of pi-switchboard** (`wayfinder:map`; Destination: an approved DESIGN.md; Decisions so far: one line per closed decision). Decision tickets as sub-issues, each closed with its resolution and evidence (DESIGN section, ADR, prompt date); blocked-by edges as in the inventory:

| # | Decision | Type |
|---|---|---|
| 39 | What is the package called, and what are its command, entry and config names? | grilling |
| 40 | Is a new package warranted, given the existing pi routers? | research |
| 41 | How does the main session pick a model each request? | research |
| 42 | How are pi-subagents children routed? (ADR-0001) | research |
| 43 | Can pi-subagents pass bindings to foreground children? (upstream PR) | task |
| 44 | Who owns failover while pi-multi-pass is installed? (ADR-0002) | grilling |
| 45 | How do classifier answers become a tier when the source ships no tier names? (ADR-0003) | grilling |
| 46 | When is an answer confident enough to act on? | grilling |
| 47 | Which classifier, and what happens when it fails? | research |
| 48 | What evidence does the classifier see, and how is it redacted? | grilling |
| 49 | How do we avoid model-switch churn and cache misses? | grilling |
| 50 | What happens when a tier or an account runs out? | grilling |
| 51 | Which selection strategies ship in v1? | grilling |
| 52 | How are decisions made auditable after the fact? | grilling |
| 53 | Does v1 include live visibility and editing of tiers? | grilling |
| 54 | One repository per package, or a scoped monorepo? | research |
| 55 | Which guardrails does the monorepo enforce? | research |
| 56 | How do tools outside npm give the same result on every host? | task |
| 57 | How are releases trusted? | task |
| 58 | Which Node floor do the packages claim? | prototype |
| 59 | Can a visitor try the real pi in a browser? (the WebContainer spike) | prototype |
| 60 | How should pi-switchboard present itself? | research |
| 61 | How are the hero video and clips made truthful? | prototype |

### pi-switchboard: spec and implementation tickets (#62–87)

Issue #62, **Spec: pi-switchboard** (`ready-for-agent`; problem, solution, 35 user stories, implementation and testing decisions, out of scope, as in the inventory), blocked by #38. Implementation tickets as sub-issues:

| # | Ticket | Blocked by | Range (count) |
|---|---|---|---|
| 63 | Record the approved design (DESIGN.md, GLOSSARY, ADR-0001 to ADR-0003) | #39–53 | `388562f..3784b6d` (5) |
| 64 | Scaffold the package with a provider-free source scan | #63 | `36150e0` (1) |
| 65 | Turn a request into a tier: config, rules and the classifier chain | #64 | `d0bacb0..e59f47a` (3) |
| 66 | Route the main session through `switchboard/auto`, with member selection and failover | #65 | `eb2efab..c4ef1ab` (2) |
| 67 | Route pi-subagents children by launch tier | #66 | `41a41bc` (1) |
| 68 | Record and explain every decision | #66, #67 | `416210c..306f8d0` (2) |
| 69 | Audit sessions offline (replay, inspector, report) | #68 | `e41d7ff` (1) |
| 70 | Watch running work live (navigator, widget, tier editor) | #67, #68 | `964d834..e7de35b` (2) |
| 71 | Propose tiers in `/tier init` | #65, #66 | `8d089f6` (1) |
| 72 | Document v1 | #64–71 | `a48ab3d` (1) |
| 73 | Link children exactly through `extensionBindings`; never route external runners | #67, #43 | `762a05e` (1) |
| 74 | Keep request text local unless `allowRemote` is set | #65 | `c3be0f1..3e6963d` (2) |
| 75 | Inspect the current session, including in-memory children | #69, #70, #73 | `cc37bf7..ba5bd96` (2) |
| 76 | Count in-flight work and run the tier's strategy at launch | #66, #67 | `bcdb25c` (1) |
| 77 | Warn at start-up about conflicting setups | #65 | `20185e1` (1) |
| 78 | Read quota from pi-usage and honour `cooldown.defaultMs` | #66 | `157f3e0..b8ea645` (2) |
| 79 | Prove loading through jiti and document the follow-ups | #72–78 | `9aa471f..6f7c8cc` (2) |

Issue #80, **Spec: pi-switchboard presentation** (from `docs/plans/presentation.md`, blocked by #60), with:

| # | Ticket | Blocked by | Range (count) |
|---|---|---|---|
| 81 | Onboard without running a model (`/tier try`, `doctor`, `tour`, first-run notice, skill) | #35 | `4b366bf` (1) |
| 82 | Rewrite the README as a front door and move reference to `docs/` | #81 | `d6bd59a` (1) |
| 83 | Add the media pipeline, brand and concept animations | #82 | `fe3455c..7957d95` (2) |
| 84 | Report a missing pi-subagents as information in `/tier doctor` (live-check follow-up) | #81 | `c421175` (1) |
| 85 | Load when installed by pi, and frame the navigator overlay (live-check follow-up) | #37 | `ebead92` (1) |
| 86 | Identify subagent children under pi 1.4 and join them to their decisions (live-check follow-up) | #85 | `051eabd..5cc3467` (3) |
| 87 | Make every on-screen line accurate (live-check follow-up) | #86 | `40f6042..8eaf1a2` (6) |
| 88 | Record the hero video and six clips from real terminal scenes | #83, #87, #61 | `420d3c5..ea5ebfe` (2) |

### This plan (#89 onward)

Issue #89, **Spec: presentation for pi-account-guard and the family site** (`ready-for-agent`), with the open tickets B1–B18 from Appendix B as #90–107.

### Ledger rules

- Every one of the 74 first-parent commits, and every commit on the imported pi-account-guard line, is in exactly one ticket's range; the two PR merges dissolve into #27 and #28.
- Main is rebuilt in the order the ranges landed: #63–79, #30–35, #36, #81–84, #37, #85–88, then #15–28. That is 47 commits, each closing its ticket.
- Ranges are contiguous on the first-parent line, so two tickets stay that a topical grouping would merge: #32 (superseded by #34, with #33 between) and #87 (starts with the catch-all wording fix).
- The full inventory (timeline, decision resolutions, user stories, acceptance criteria) is kept in `.git/purge/` next to the export and turned into ticket bodies in 0.7.
