# History import

This package was developed in the private repository `crisboarna/pi-account-guard` and imported into this monorepo with its full history and issues. This page maps the old identifiers to the new ones so links in commits, issues and documents can be followed.

## How it was imported

- Every commit of `integration/account-guard-v1` (72 commits, 4 of them merges) was rebuilt with `git commit-tree` under `packages/pi-account-guard/`: same tree, same author and committer, same dates, same merge topology, now signed. The first commit's parent is the monorepo `main` it was imported onto.
- Each header now uses the `pi-account-guard` scope. Every imported commit ends with an `Imported-from: crisboarna/pi-account-guard@<sha>` trailer, and a commit whose subject changed beyond the scope also carries `Original-subject:` with the old header.
- The unmerged wayfinder research and prototype branches were rebuilt the same way and kept as branches, never merged.
- The issues were recreated in this repository with their comments, labels, sub-issues and blocked-by links. Each starts with a line that names its original number.

## Issues

Source issue #22 was deleted before the import; source pull request #28 became the import pull request.

| Source | Here | Title |
|---|---|---|
| crisboarna/pi-account-guard#1 | #1 | Map: design spec for pi-account-guard |
| crisboarna/pi-account-guard#2 | #2 | Which pi hooks can stop a turn or a mid-turn model change before send? |
| crisboarna/pi-account-guard#3 | #3 | Can an extension identify which pooled credential a request uses? |
| crisboarna/pi-account-guard#4 | #4 | How do pi-multi-pass restriction and rotation interact with a second guard? |
| crisboarna/pi-account-guard#5 | #5 | What are the place rule semantics? |
| crisboarna/pi-account-guard#6 | #6 | How does the guard behave when it cannot decide? |
| crisboarna/pi-account-guard#7 | #7 | What are the config schema and the tag prompt flow? |
| crisboarna/pi-account-guard#8 | #8 | What does a Block look like in TUI, print and RPC modes? |
| crisboarna/pi-account-guard#9 | #9 | Should the Account key include auth source, and how do pooled providers fail closed? |
| crisboarna/pi-account-guard#10 | #10 | Should the guard check every provider request through the context hook? |
| crisboarna/pi-account-guard#11 | #11 | Can the guard resolve a virtual routing model to its real member account? |
| crisboarna/pi-account-guard#12 | #12 | What does the guard show when idle, and what does /guard status list? |
| crisboarna/pi-account-guard#13 | #13 | What is the testing strategy for the guard? |
| crisboarna/pi-account-guard#14 | #14 | Spec: pi-account-guard |
| crisboarna/pi-account-guard#15 | #15 | Scaffold the package and test harness |
| crisboarna/pi-account-guard#16 | #16 | Prove the assumed pi behaviours |
| crisboarna/pi-account-guard#17 | #17 | Tracer bullet: block a mismatched turn in headless mode |
| crisboarna/pi-account-guard#18 | #18 | Interactive Block with Switch and Overrides |
| crisboarna/pi-account-guard#19 | #19 | Block a model change mid-turn and re-check when idle |
| crisboarna/pi-account-guard#20 | #20 | Remote place rules and git failure |
| crisboarna/pi-account-guard#21 | #21 | Fail closed on a bad config |
| crisboarna/pi-account-guard#23 | #22 | Tag an Unknown account |
| crisboarna/pi-account-guard#24 | #23 | `/guard` tag, untag, status and the full footer |
| crisboarna/pi-account-guard#25 | #24 | `/guard` place and zone commands |
| crisboarna/pi-account-guard#26 | #25 | Auth source resolvers and pooled provider warning |
| crisboarna/pi-account-guard#27 | #26 | JSON Schema, README and manual checklist |
| crisboarna/pi-account-guard#28 (pull request) | #30 | Implement pi-account-guard (spec #14) |

## Branches

| Source branch | Branch here | Tip here |
|---|---|---|
| `integration/account-guard-v1` | merged through the import pull request | `d20603810a6e` |
| `research/multi-pass-interplay` | `research/pi-account-guard/multi-pass-interplay` | `6c798169bdac` |
| `research/pi-hook-gating` | `research/pi-account-guard/pi-hook-gating` | `5b14050a99d5` |
| `research/pooled-credential-identity` | `research/pi-account-guard/pooled-credential-identity` | `3ca1816b3229` |
| `research/switchboard-routing` | `research/pi-account-guard/switchboard-routing` | `536eab079fe5` |
| `prototype/block-ux` | `prototype/pi-account-guard/block-ux` | `f7c3141097e9` |

## Commits

| Source | Here | Subject here |
|---|---|---|
| `82ee57e` | `6276290` | docs(pi-account-guard): add domain glossary |
| `606ab36` | `239fc0f` | docs(pi-account-guard): refine place rule definition |
| `d35e373` | `246bb96` | docs(pi-account-guard): ADR for fail-closed guard, process override scope |
| `62a1a3d` | `58f810a` | docs(pi-account-guard): key the Account by provider id plus auth source (ADR 0002) |
| `d9d4e99` | `1e0f4ab` | docs(pi-account-guard): ADR for one global config file (ADR 0003) |
| `f873273` | `1bbde2d` | docs(pi-account-guard): scope Override to one account |
| `a735afb` | `d1b6d29` | docs(pi-account-guard): assemble DESIGN.md, ADRs 0004 and 0005, Tag prompt term |
| `e94d1a1` | `5c97636` | docs(pi-account-guard): mark DESIGN.md approved |
| `3771903` | `9361d00` | chore(pi-account-guard): add package manifest, strict tsconfig and pi link script |
| `b1f77e0` | `afda9a1` | test(pi-account-guard): scan src for real ids and keep src/core free of pi imports |
| `565d1c1` | `15aa4e5` | feat(pi-account-guard): load an empty extension, with a fake-pi host that loads it through jiti |
| `862a4fd` | `9673214` | test(pi-account-guard): add offline stub provider and smoke harness driving real pi |
| `cadd4d9` | `8c57c5d` | test(pi-account-guard): prove the assumed pi behaviours with smoke tests against real pi |
| `5c193b6` | `a0e8f84` | docs(pi-account-guard): record verified pi behaviours and claude-bridge auth precedence |
| `3c63e86` | `12ee9de` | feat(pi-account-guard): build the Account key from provider id and auth source |
| `ae4f8f7` | `0f2f139` | feat(pi-account-guard): parse and validate the config subset for zones, tags and path rules |
| `9c232c9` | `f914d26` | feat(pi-account-guard): resolve a place to a zone with ordered path rules |
| `c3ec89b` | `f9ba4fe` | feat(pi-account-guard): decide Match or Block and word the headless Block message |
| `f536564` | `9ababcc` | feat(pi-account-guard): gate user turns on the input hook; block mismatched headless turns, exit 77 |
| `1fba724` | `7eca58f` | test(pi-account-guard): cover the headless block end to end against real pi |
| `20fde92` | `a495241` | docs(pi-account-guard): describe the headless block in the readme |
| `c838a18` | `a1e0577` | feat(pi-account-guard): scope allow-once and session overrides to an account and place |
| `d936c2f` | `8e5651b` | feat(pi-account-guard): build the Block select rows, titles and notices |
| `fc39f63` | `dbe5693` | feat(pi-account-guard): open the Block select in the input gate with Switch, Cancel, overrides |
| `5dd7b0f` | `165ec5b` | test(pi-account-guard): cover the interactive block over RPC against real pi |
| `bf58341` | `95a85ed` | docs(pi-account-guard): describe the interactive block in the readme |
| `f76d7b6` | `5f45804` | feat(pi-account-guard): match place rules on a remote condition; git failure is undecidable |
| `cfa98d2` | `354e6a7` | feat(pi-account-guard): read remotes with git and block when git fails while a remote rule matters |
| `f513e54` | `a0682d1` | Merge #20 remote place rules and git failure |
| `87bc65b` | `2288ced` | feat(pi-account-guard): keep the last valid config and refuse writes over a malformed file |
| `882bfb7` | `781fa83` | feat(pi-account-guard): fall back to the last valid config and contain handler errors |
| `2221eab` | `70b8b11` | Merge #21 fail closed on a bad config; adapt its tests to the interactive Block |
| `facfc1b` | `8b319b2` | feat(pi-account-guard): words and select rows for a blocked mid-turn model change |
| `1c826c4` | `46f40cf` | feat(pi-account-guard): abort a mid-turn model change and re-check before the agent starts |
| `8c613d3` | `adeb622` | fix(pi-account-guard): keep exit code 77 after print mode reports the aborted run |
| `0e6ee39` | `3f65156` | feat(pi-account-guard): write the config atomically after a fresh read |
| `0a4d5a1` | `2ccd828` | feat(pi-account-guard): word the tag prompt and find the zones a pi-multi-pass label names |
| `3712aaa` | `496f414` | feat(pi-account-guard): decide where the process Override applies |
| `8396cc9` | `d0b2fe3` | feat(pi-account-guard): model the checkbox list of the TUI tag prompt |
| `cba6c0b` | `d136664` | feat(pi-account-guard): ask the Tag prompt for an Unknown account in the input gate |
| `53bd3fb` | `ccf3bf7` | test(pi-account-guard): cover the process Override in print, JSON, RPC and the TUI |
| `035c1a7` | `e8c483f` | feat(pi-account-guard): wire the config writer, the process environment and the pi-multi-pass label |
| `42b4147` | `346b325` | test(pi-account-guard): cover the tag prompt and the process Override against real pi |
| `4058e26` | `e4c248f` | docs(pi-account-guard): describe the tag prompt and the process Override in the readme |
| `8cc6872` | `78bacfd` | Merge #22 tag an Unknown account; apply the process Override in the model guard too |
| `c71fe32` | `1c04808` | docs(pi-account-guard): record the exit code 77 workaround for aborted runs |
| `c8be8c7` | `83a39e1` | feat(pi-account-guard): footer, status and account-list text for /guard |
| `1fcada2` | `01d646c` | feat(pi-account-guard): /guard tag, untag, status and the full footer |
| `f697e00` | `a834a5a` | test(pi-account-guard): wait for the Override footer text in the smoke tests |
| `040f06d` | `a69da1e` | feat(pi-account-guard): resolve the claude-bridge auth source from env or Claude Code config |
| `9d3f616` | `9ed86d7` | feat(pi-account-guard): warn in the tag prompt when a provider id pools several accounts |
| `d3998f8` | `b63a740` | test(pi-account-guard): cover claude-bridge sources, pooled warning and virtual models end to end |
| `6fd7038` | `e371cb6` | Merge branch 'pi-subagents/task-2-e9e29bd-2fc7-s0-t0' into integration/account-guard-v1 |
| `87e6023` | `1aeec46` | feat(pi-account-guard): wire the pooled provider listing into /guard status |
| `ae970d9` | `6a3a0f5` | feat(pi-account-guard): add the pure place rule and zone edits |
| `2b27b05` | `3e0c9f6` | feat(pi-account-guard): parse the /guard place and zone arguments |
| `d931e39` | `855b10f` | feat(pi-account-guard): add /guard place and zone commands |
| `f035b5b` | `7681a98` | test(pi-account-guard): smoke the /guard place and zone commands over RPC |
| `67b118f` | `32d296a` | feat(pi-account-guard): ship the config JSON Schema, an example and a schema-to-code test |
| `dd1150c` | `259867d` | docs(pi-account-guard): add the manual checklist of DESIGN.md section 17.2 |
| `f39992e` | `e594e30` | docs(pi-account-guard): rewrite the README as one user-facing guide |
| `1fc5d89` | `9150746` | fix(pi-account-guard): match a leading ** at any depth and run globs in linear time |
| `948878e` | `ab9bbe0` | fix(pi-account-guard): keep unrecognised and unlabelled sources apart, and scrub git error text |
| `3c3b49b` | `031931e` | fix(pi-account-guard): offer both Overrides on an internal-error Block in the TUI |
| `6f50fd7` | `b5a1a65` | fix(pi-account-guard): exit 77 when a handler fails without a UI, and wrap every handler |
| `f08d717` | `a4e45bc` | fix(pi-account-guard): log a turn that starts without input |
| `2cc51b4` | `92d4e71` | fix(pi-account-guard): end Allow once when the turn never reaches agent_end |
| `e0230f8` | `10a7e72` | fix(pi-account-guard): list the tags of accounts the registry no longer knows |
| `a824e18` | `267c04b` | refactor(pi-account-guard): pass the account resolver and exit-code keeper, drop module state |
| `7cbcdbf` | `2ba1ae6` | refactor(pi-account-guard): use the GLOSSARY terms in code and text |
| `dd5f4f6` | `2d91cc6` | refactor(pi-account-guard): share the duplicated path, place and notice helpers |
| `b94fb1f` | `d206038` | docs(pi-account-guard): bring DESIGN.md in line with the code and list the accepted deviations |
| `d0fda7d` | `6c79816` | docs(pi-account-guard): research multi-pass-interplay findings |
| `8436eab` | `2c969ef` | docs(pi-account-guard): research pi-hook-gating findings |
| `e42b36f` | `5b14050` | docs(pi-account-guard): research: drop agent preamble line |
| `a16dc8d` | `3ca1816` | docs(pi-account-guard): research pooled-credential-identity findings |
| `0220857` | `536eab0` | docs(pi-account-guard): research switchboard virtual model routing (throwaway) |
| `afff5d5` | `f7c3141` | docs(pi-account-guard): prototype Block UX text mockups (throwaway) |
