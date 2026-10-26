# pi-account-guard

A pi extension that stops a session from sending a user turn to a model account that does not belong to the zone of the directory the session works in. See `DESIGN.md` for the design, `GLOSSARY.md` for the vocabulary and `docs/adr/` for the decisions.

Status: a turn whose account does not match the place zone is blocked. In headless mode the message goes to stderr and the exit code is 77. In the TUI and over RPC a Block opens one select: Switch rows for the matching accounts, Allow once, Allow for session and Cancel. Cancel puts the typed prompt back in the editor, and an Allow for session shows `guard OVERRIDE <account> in <zone>` in the footer. Overrides are never written to disk and end with the session. Configuration is read from `account-guard.json` in the pi agent directory; place rules match a path, a git remote or both (a remote such as `*/Acme/*` is matched against the normalized `host/path` of every remote, and git failing while a remote rule matters blocks the turn). An account with no tag is in the Unknown zone and opens a one-step tag prompt before the Block select: a checkbox list in the TUI, a select of single zones plus a `Several zones…` input over RPC. The first tag creates `account-guard.json` with the defaults spelled out; the guard re-reads the file before each write, writes it atomically and never writes over a malformed file (the prompt is off while the file is malformed). A tag that gives a Match sends the turn at once. Without a UI the message names the JSON entry to add, and `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1` lets accounts with no tag (and only those) through in print, JSON and RPC mode, logging each turn and warning once per session; the TUI ignores it.

`/guard` prints a status block (the place and the rule that decides it, the current account and its Match, Overrides, the config file and whether it is valid, zones, pooled provider ids and untagged accounts); it prints the same text in the TUI and over RPC and nothing in print and JSON mode. `/guard tag [provider [source] [zones]]` tags the current account by default (a provider alone means its current source; zones are comma-separated), asks for the zones when they are missing, and shows old to new and asks to confirm when it changes the zones of a tagged account. `/guard untag [provider [source]]` removes a tag and needs no confirm. With no UI, a command with missing arguments fails with its usage on stderr and exit code 2, and a change of existing zones is refused because it cannot be confirmed (untag first). The `/guard place` and `/guard zone` commands are not built yet.

The footer item `guard` always shows the place zone and the Match state: `guard personal ✓`, `guard personal ✗ anthropic is work`, `guard personal ? untagged`, `guard OVERRIDE anthropic in personal`, `guard ! config invalid (last valid copy in use)`, `guard ! config invalid, turns blocked` and `guard ! zone unknown (git failed)`. It is drawn again on session start, model change, Override change, tag change and at each turn. pi-powerline-footer shows a status key only after you add it to `powerline.customItems`, so add `guard` there to see the item.

A claude-bridge model gets its account from the environment key variable that Claude Code would use (`env:<VAR>`), else from the resolved `CLAUDE_CONFIG_DIR` (`~/.claude` by default), so a work and a personal config directory are different accounts; cloud provider and `apiKeyHelper` setups share one `claude-code` account. Reading `settings.json` only checks that `apiKeyHelper` is set. A provider id that pi-multiprovider pools over several accounts gets a warning in the tag prompt: tag it only if all of them share one zone. A pool alone never blocks. A virtual routing model is tagged like any other account.

A model change while a turn runs (rotation, `/model`, router fallback) aborts the turn with a notice that says a failover was blocked. Once idle, the same select opens with the previous account first and without Allow once; Cancel leaves the model as it is, and the aborted turn is never resumed. An account switched while pi was idle is caught in `before_agent_start`, before the first request. Headless runs write the message to stderr and exit with 77, also after pi print mode has reported the aborted run.

## Development

Requires Node 22.19 or later and an installed pi release.

```sh
npm run link:pi          # link the host packages from the installed pi release
npm run typecheck        # tsc --noEmit, strict
npm test                 # unit tests on the pure core (src/core)
npm run test:integration # fake-pi host loading src/index.ts through jiti
npm run test:smoke       # opt-in: real pi, offline, with the stub provider
```

The smoke tests run the `pi` on `PATH` (override with `PI_BIN`) with `PI_OFFLINE=1`, an empty agent directory and credential environment variables removed. `test/support/stub-provider.ts` answers every prompt locally.
