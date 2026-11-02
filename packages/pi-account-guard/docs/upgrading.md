# Upgrading

Read this before you upgrade `@crisboarna/pi-account-guard`. It says what an upgrade keeps and what to run afterwards.

## What an upgrade keeps

- **`account-guard.json`**, in the agent directory (`~/.pi/agent/`). This is the only configuration: zones, the default zone, the tags of your accounts and your place rules ([ADR 0003](adr/0003-one-global-config-file.md)). An upgrade never rewrites it. `/guard tag`, `/guard place` and `/guard zone` are the only things that write it. The file has no version number; it is read as it is.
- **`account-guard.first-run`**, in the same directory: one line that records that the first-run notice was shown, so the notice is not shown again.

The guard rejects a field it does not know, so a file with a field this version does not know does not parse. When the guard cannot read the file, or cannot decide, it blocks the turn and names the cause and the fix ([ADR 0001](adr/0001-fail-closed-when-undecidable.md)). It does not let the turn through.

After you upgrade, run `/guard check`. It says whether a turn would go, be blocked or ask first, and it writes nothing.

## Which pi it works with

pi 1.4 up to, not including, 2.0. CI runs the real-pi tests with the oldest and the newest release of that range, and a nightly run tries the newest pi there is. A release that changes this range says so in its changelog.

## How breaking changes are announced

A breaking change is a major release. Its changelog entry says what broke in one sentence, and a section headed with the version, such as `## 2.0`, is added below with the old behaviour, the new behaviour and the exact edit to make.

No release has broken anything yet; this is the first release.
