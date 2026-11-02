# Upgrading

Read this before you upgrade `@crisboarna/pi-switchboard`. It says what an upgrade keeps and what to run afterwards.

## What an upgrade keeps

- **Your config**, `~/.pi/agent/pi-switchboard.json` (or the path in `PI_SWITCHBOARD_CONFIG`), and any `.pi/pi-switchboard.json` of a project. An upgrade never rewrites them. `/tier models` and `pi-switchboard classifier setup` write the config, and the tier editor saves a timestamped `.bak` copy of the old file first.
- **Files under `~/.pi/agent/pi-switchboard/`**: `health.json` (shared cooldowns and pointers), `usage.jsonl` (the usage ledger), `state.json` (the global profile and one-time notices), `live/` (subagent status and transcript mirrors, deleted 24 hours after a child ends), `inspect/` (the HTML inspector) and `decisions.jsonl` (only with `debug.log`). Whichever version runs reads and writes them.
- **Your sessions.** The decisions already recorded in a session stay in it, and `/tier explain` and the inspector read them.

## What to run afterwards

`/tier validate` checks the config against this version's schema and reports unknown tiers in rules, a missing or misplaced default rule, duplicate ranks, and members that are not in pi's catalog or have no credentials. `/tier doctor` checks the config, the classifiers (with a warm-up request), model selection, subagents, the footer and pi-usage, and says what to fix. `/tier dry-run on` classifies and records while the baseline tier runs, so you can see what a new config would do before it routes anything.

## Which pi it works with

pi 1.4 up to, not including, 2.0. CI runs the real-pi tests with the oldest and the newest release of that range, and a nightly run tries the newest pi there is. A release that changes this range says so in its changelog.

## How breaking changes are announced

A breaking change is a major release. Its changelog entry says what broke in one sentence, and a section headed with the version, such as `## 2.0`, is added below with the old behaviour, the new behaviour and the exact edit to make.

No release has broken anything yet; this is the first release.
