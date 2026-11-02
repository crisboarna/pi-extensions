# Upgrading

Read this before you upgrade `@crisboarna/pi-context-refs`. It says what an upgrade keeps and what to expect afterwards.

## What an upgrade keeps

- **Your library**, `pi-context-refs.json` in the agent directory (`~/.pi/agent/`), and a **Project library**, `.pi/pi-context-refs.json`. Both carry `"version": 1`. An upgrade never rewrites them; `/ref add`, `edit` and `remove` and the overlay's save are the only things that write them, and a write keeps any key this version does not know. A file whose `version` is not 1 is not loaded: the last good copy stays in use and the file is reported in `/ref list`.
- **Your Approvals**, `pi-context-refs-approvals.json` in the agent directory. Each one is keyed by the project, the ref's name and a hash of its definition ([ADR 0004](adr/0004-approve-project-dynamic-refs-by-definition-hash.md)), so an upgrade keeps them and an edited definition asks again.
- **Messages you already sent.** Each holds the full text of its refs ([ADR 0006](adr/0006-store-the-expansion-in-the-user-message.md)), so a resumed session shows the same text with or without the package.

## What can change under you

The Placeholder acts as one unit because the package wraps a private method of pi's editor ([ADR 0001](adr/0001-atomic-text-placeholder-over-private-segment.md)). A pi upgrade can remove that method. Then `[ref:name]` is plain text: Backspace deletes one character at a time, and the text still expands when you send. A test checks the method on every build of the package, so a release says when it no longer holds.

## Which pi it works with

pi 1.4 up to, not including, 2.0. CI runs the real-pi tests with the oldest and the newest release of that range, and a nightly run tries the newest pi there is. A release that changes this range says so in its changelog.

## How breaking changes are announced

A breaking change is a major release. Its changelog entry says what broke in one sentence, and a section headed with the version, such as `## 2.0`, is added below with the old behaviour, the new behaviour and the exact edit to make.

No release has broken anything yet; this is the first release.
