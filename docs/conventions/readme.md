# Package README standard

A README is the front door, not the manual: it is the npm page, the pi gallery page and the first file an agent reads before installing. A first-time reader needs, in the first screen: what it is, whether it is for them, and how to start. Reference material goes to `docs/` inside the package.

Adapted from [rpiv-mono's README standard](https://github.com/juicesharp/rpiv-mono/blob/main/docs/readme-standard.md).

## Section order

```text
# @crisboarna/<name>
[badges: one line, at most 8]
[banner or cover image, then a demo video if there is one]

<lede: 2–3 sentences>

## Install
## Quick start
## What you get
## Configuration      (only if the user configures it)
## Reference          (only if docs/ exists)
## Requirements
## Data and privacy
## Troubleshooting    (only for failures users hit)
## Limitations
## Uninstall
## License
```

Requirements, Data and privacy and Uninstall are in every package README, because a person decides whether to install from them. The other sections are skipped rather than padded. Do not invent other top-level sections; a package may add sections that explain how it works between What you get and Configuration.

## Rules

- **Lede**: sentence one says what it does in the user's words; sentence two says how (the command, tool or screen it adds); sentence three, if needed, who it is for. No adjectives like "powerful" or "seamless".
- **Badges**: a single line, at most 8, in this order: release (npm version), quality (CI, coverage, tests), compatibility (pi tested, Node), trust (Scorecard, provenance), and a link to the try-it page. Every value comes from a registry, from CI or from the repository, never from a number typed into the README, and there is no badge for something CI does not enforce. The site build removes the badge line from the pages it renders.
- **Install**: `pi install npm:@crisboarna/<name>` and "Restart pi". Nothing else.
- **Quick start**: the shortest path to seeing it work, with what the user sees. A gate (an API key, a local server) belongs here, not under Configuration.
- **What you get**: 5–7 bullets, bold benefit first, then one sentence on how.
- **Configuration**: the file path once, then a table of the settings most people change: setting, effect, default.
- **Reference**: one line per `docs/` page saying what is in it, including `docs/upgrading.md` (see [upgrade notes](upgrading.md)).
- **Requirements**: the first line states the versions in these words: "Node 22.19 or later; pi 1.4 up to, not including, 2.0." The pi range is `PI_PEER_RANGE` in `scripts/lib/repo.ts`, the range CI tests; never write "or later" for pi. Below it, one table of how the package behaves in each way pi runs: interactive, print (`-p`), JSON and RPC. A row says what works, what is off and any exit code. Say that Windows is not tested and to use WSL.
- **Data and privacy**: short bullets, each checked against the source and each naming nothing it cannot back up: network calls (to whom, and only when), processes it starts, files it reads, files it writes (with paths), and "no telemetry" only if no code sends any. End with the honest limits. A test that scans `src/` for network and process use keeps the bullets true.
- **Troubleshooting**: symptom, cause, fix — only for reported failures.
- **Limitations**: what does not work yet and what is not verified. Honest limits earn trust.
- **Uninstall**: `pi remove npm:@crisboarna/<name>`, then the files the package left behind and where they are.
- Images have alt text that describes what the image shows. Keep the source (SVG, tape, fixture) in the package so the asset can be rebuilt.
