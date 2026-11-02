# Launch kit

Drafts for announcing the three packages, and the checks to pass first. **Nothing here is posted.** Posting is the maintainer's decision, from the maintainer's own accounts, after the checklist below passes.

Files:

- [`pi-gallery.md`](pi-gallery.md): the one-line listing for each package.
- [`hacker-news.md`](hacker-news.md): a Show HN title and first comment.
- [`social.md`](social.md): posts for X, Bluesky, Mastodon and LinkedIn.

## Rules for every post

- **Say what it does, in the user's words.** No "powerful", "seamless", "blazing", "revolutionary", "best" or "first".
- **Every claim has a link.** The table below lists the claims you may make and the page that backs each one. If a claim is not in the table, do not make it; add it to the table with its evidence first.
- **Say the limits.** Windows is not tested. pi 1.4 up to, not including, 2.0. The live model-server suites run on demand, not on every change.
- **Ask for one thing:** a bug report or a false positive, with the diagnostics output (`/guard check`, `/tier doctor` or `/ref doctor`).
- **No numbers that change.** Do not quote a test count or a coverage figure in a post; link the badge or the gate instead.

## Claims you may make

| Claim | Evidence |
|---|---|
| Each package installs and works on its own. | [AGENTS.md, Package boundaries](../../AGENTS.md#package-boundaries); the tarball smoke test, `npm run smoke:pack`. |
| It is tested against the oldest and the newest pi it supports. | The peer range in each `package.json`; [pi-compat.yml](../../.github/workflows/pi-compat.yml) runs the floor and latest on every pull request. |
| The keystroke flows are tested in a real pi on a virtual terminal. | [Testing guide, Real TUI](../conventions/testing.md). |
| The tests are shown able to fail. | The mutation canary, [Testing guide](../conventions/testing.md); entries in `scripts/mutations/`. |
| pi-account-guard blocks when it cannot decide. | [ADR 0001](../../packages/pi-account-guard/docs/adr/0001-fail-closed-when-undecidable.md). |
| Each package says what it reads, sends and starts. | The Data and privacy section of each package README, held to the source by `test/unit/side-effects.test.ts`. |
| The repository's gates and why each exists. | [Guardrails](../guardrails.md). |
| The Scorecard result and the coverage number. | The badges in the README read the published OpenSSF result and the verified main branch. |

## Before the first post

Tick every line. A line you cannot tick is a reason to wait.

- [ ] The release pull request is merged and the three packages are on npm at the version the changelog says.
- [ ] `pi install npm:@crisboarna/<name>` works from a clean machine for each package, and `/guard`, `/tier` and `/ref` appear.
- [ ] Every badge in the three package READMEs and the root README resolves, the npm badge and the provenance badge included.
- [ ] The site is live and the search, the explainers and the live demos load.
- [ ] The social preview is uploaded (Settings → General → Social preview; the file is `media/social.png`).
- [ ] The repository description and topics are set as in [Repository settings](../repository-settings.md).
- [ ] Every claim in the post is in the table above, with its link in the post.
- [ ] No superlative, no changing number, and the limits are stated.
- [ ] Someone other than the author has read the post.
- [ ] You can answer issues for the first week.
