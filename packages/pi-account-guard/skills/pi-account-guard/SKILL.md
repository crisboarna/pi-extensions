---
name: pi-account-guard
description: Explain pi-account-guard blocks, zones and place rules, and propose /guard commands. Use when the user asks why a turn was blocked, which zone a directory or account is in, or how to set up work and personal accounts.
---

# pi-account-guard

pi-account-guard blocks a turn when the account pi is about to use is not tagged with the zone of the directory pi works in. An account is a provider id plus its auth source (`oauth`, `env:<VAR>`, ...). Place rules map directories and git remotes to zones; a directory no rule matches gets the default zone. Slash commands are the user's: you read files and propose commands, and the user runs them.

## Read the setup

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
cat "$AGENT_DIR/account-guard.json"     # zones, defaultZone, accounts (tags), places (rules, first match wins)
git remote -v                           # the remotes the place rules see
```

The schema is `schema/account-guard.schema.json` in the package (`$AGENT_DIR/npm/node_modules/@crisboarna/pi-account-guard/`). It cannot check two rules the guard checks itself: every zone a tag, rule or `defaultZone` names is declared in `zones`, and no two accounts share a provider and source. A missing file means zones `work` and `personal`, default `personal`, no tags and no rules.

## Explain a block

1. Ask for the block text if it is not in the conversation. Its first line names the account and its zone, or says the account has no tag; the second names the place and its zone.
2. Find the rule that decides the place: go through `places` in file order and stop at the first whose `path` contains the directory and whose `remote` glob matches a remote (both must hold when both are given). No match means `defaultZone`.
3. Say in plain words which of the two is wrong for the user's intent: the account's tag, or the directory's zone. Done when the user can tell why this account in this directory was blocked.

## Propose a fix

- The directory belongs to another zone: `/guard place add path=here zone=<zone>`, or for every repository of an organization `/guard place add remote=<host>/<org>/* zone=<zone>`. `/guard check <path>` shows the result before the user relies on it.
- The account belongs to this zone too: `/guard tag <provider> <source> <zones>`, with every zone it belongs to, comma-separated.
- The user picked the wrong account: tell them to switch to an account of this zone; the block's Switch rows list them.
- After a hand edit of `places`, the user runs `/reload`; `/guard` then shows the place, its rule, the account and whether it matches, and whether the file is valid.

## Never

- Never propose `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN`, Allow for session, or a tag the account does not really belong to, to get a turn through. A block is the guard working.
- Never edit `account-guard.json` to make a block pass, and never delete or empty it: that blocks every turn or drops every tag.
- Never read or print credentials (`auth.json`, key variables); the guard needs only provider ids and sources.
