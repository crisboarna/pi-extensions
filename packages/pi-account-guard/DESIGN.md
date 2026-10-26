# pi-account-guard design

Status: **approved 2026-10-26**. Terms in bold are defined in [GLOSSARY.md](GLOSSARY.md). The hardest decisions have ADRs in [docs/adr/](docs/adr/). This document is the destination of the wayfinder map [Map: design spec for pi-account-guard](https://github.com/crisboarna/pi-account-guard/issues/1); every section names the ticket that decided it. No extension code exists yet.

## Summary

pi-account-guard is a pi extension that stops a user turn from reaching a model **account** that does not belong to the **zone** of the directory the session works in. Its purpose is that a work subscription is never used by accident in a personal repository, and the reverse.

- Each account carries a set of zones (its **zone tags**). Each **place** resolves to one zone through ordered **place rules**, or falls to a default zone.
- A turn proceeds only on a **match**: the place's zone is one of the account's zones. Everything else is a **block**, with a picker of matching accounts and two **overrides** (allow once, allow for the session).
- The guard never switches accounts by itself and fails closed when it cannot decide.

```text
user turn ─▶ input ─▶ place zone (cached) ─┐
                      account key (fresh) ─┼─▶ decide() ─▶ Match ─▶ turn proceeds
before_agent_start (idle re-check) ────────┤              ─▶ Block ─▶ tag prompt (Unknown)
model_select / session_start ──────────────┘                        ─▶ select: Switch · Allow once ·
model change during a turn ─▶ ctx.abort()                              Allow for session · Cancel
                                                                     ─▶ headless: stderr, exit 77
```

## 1. Goals, non-goals, threat model

Goals:

- Stop the accident. Examples: the wrong model is selected, the user forgot to switch after changing directory, a fallback rotated to a work account.
- Make the decision visible: a footer item, a `/guard` status view, session log entries.
- Never lock the user out of pi, even with a broken config.

Threat model (settled while charting): accidents only. A hostile repository, agent or extension that wants to bypass the guard is out of scope.

Non-goals (v1):

- Subagent child processes and other extensions' own HTTP clients (for example claude-bridge's `AskClaude` tool). Only the main session's user-started turns and model changes are guarded.
- Checking every provider request. There is no `context` gate (section 14, decided in [Should the guard check every provider request through the context hook?](https://github.com/crisboarna/pi-account-guard/issues/10)).
- Resolving a virtual routing model to its real member account (section 13.2, ADR 0004).
- Automatic switching of accounts. The guard blocks; it never calls `pi.setModel` except for a user's explicit Switch pick.
- Changing pi-multi-pass, pi-switchboard or pi-powerline-footer. Upstream issues instead.

## 2. Prior art and why a new package

pi-multi-pass 1.12.0 already has a per-project `allowedSubs` allow-list (`extensions/multi-sub.ts`, `enforceProjectRestriction`). It is not enough:

| Aspect | pi-multi-pass `allowedSubs` | pi-account-guard |
|---|---|---|
| Identity of a place | the project file in the cwd | place rules on path and git remote, global |
| Failure mode | fails open on a missing or malformed file, an empty list or a subdirectory cwd | fails closed (ADR 0001) |
| Reaction | auto-switches to an allowed subscription | blocks, never switches by itself |
| Scope | multi-pass pools only | any provider, tagged by account |
| Untagged accounts | not a concept | Unknown zone: blocked, with a tag prompt |

The guard is independent of pi-multi-pass: both can run, and section 13.1 says how they interact.

## 3. Concepts

See [GLOSSARY.md](GLOSSARY.md): **Zone**, **Default zone**, **Unknown zone**, **Zone tag**, **Account**, **Auth source**, **Place**, **Place rule**, **Match**, **Block**, **Override**, **Tag prompt**. This document uses those words and no synonyms.

## 4. Configuration

Decided in [What are the config schema and the tag prompt flow?](https://github.com/crisboarna/pi-account-guard/issues/7) and ADR 0003.

One file holds all configuration: `~/.pi/agent/account-guard.json`. There is no project-level file (ADR 0003).

```json
{
  "zones": ["work", "personal"],
  "defaultZone": "personal",
  "accounts": [
    { "provider": "openai-codex-2", "source": "oauth", "zones": ["work"], "note": "Acme seat" }
  ],
  "places": [
    { "remote": "*/acme-corp/*", "zone": "work" },
    { "path": "~/Projects/acme", "zone": "work" }
  ]
}
```

- `zones` declares every zone. A tag or rule that names an undeclared zone is an error. `unknown` is reserved and cannot be declared.
- `accounts` is an array with one object per Account: `provider` plus `source` (the ADR 0002 key) and a non-empty `zones` list. An empty list is an error: an account is either Unknown (absent) or in at least one zone.
- `places` entries follow section 5. File order is precedence.
- Account and place entries allow an optional free-text `note`. Matching ignores it. Plain JSON has no comments.
- When `zones` or `defaultZone` is absent, built-in defaults apply: zones `work` and `personal`, default zone `personal`. A missing file is therefore `{zones: [work, personal], defaultZone: personal, accounts: [], places: []}`. When the guard writes the file, it spells the defaults out.
- A JSON Schema ships as `schema/account-guard.schema.json`.

Validation is strict and all-or-nothing. Any of these makes the whole file invalid: an unknown field, a duplicate `(provider, source)` entry, an undeclared or reserved zone, an empty zones list, a bad rule. Every error names the file and the JSON path, for example `account-guard.json: accounts[3]: duplicate of accounts[1] (openai-codex-2 · oauth)`.

Reads and writes:

- The file is read live (zone tags and everything except the cached place zone, section 5.4), so the tag prompt unblocks at once.
- Before each write the guard re-reads the file and refuses if it is malformed. Then it applies the change and writes atomically (temp file plus rename), pretty-printed with a 2-space indent. Hand formatting is normalized on the first guard write.
- The guard never writes over a malformed file.

## 5. Place resolution

Decided in [What are the place rule semantics?](https://github.com/crisboarna/pi-account-guard/issues/5).

1. **Place path.** The place is the session cwd, not the git root, resolved with native `realpath` (canonical case on macOS). Only the real path is matched; a rule written against a symlink alias misses and falls to the default zone. Git is used only to read remotes, from the cwd (git finds the enclosing repository itself, worktrees included).
2. **Path syntax.** `~` is expanded. A path with no glob characters (`~/Projects/scout`) matches that directory and everything below it. A path with glob characters uses standard globs (`*` one segment, `**` any depth, `{a,b}`). Matching is case-sensitive against the canonical real path. Rule paths are realpath'd at load when they exist; a path that does not exist yet is matched as the literal `~`-expanded path, with no warning, because rules for future directories are legitimate.
3. **Remote condition.** Every configured remote's fetch URL is considered; the condition holds if any remote matches. URLs are normalized to `host/path`: scheme, user and `.git` suffix stripped, `:` replaced by `/`, percent-decoded. The host is kept as written; SSH config aliases are not resolved (so `github.com-acme/billing-portal/*` or `*/billing-portal/*`). Remote matching is case-insensitive.
4. **Rule shape.** A rule has an optional path and an optional remote; at least one is required, and when both are present both must hold. Remote-only rules are allowed (`*/acme-corp/*` catches a clone anywhere on disk).
5. **Precedence.** The first matching rule in file order wins. The user lists specific rules first (for example a personal-remote rule under `~/Projects/acme` before the plain `~/Projects/acme` rule). No match falls to the default zone.
6. **Non-git and no-remote places.** Rules with a remote condition do not match; path-only rules still apply. Git failing to run (binary missing, corrupt repository, timeout) is not "no remote": it is the undecidable case in section 7.

### 5.4 Resolution timing

The place zone is resolved at every pi `session_start` (startup, `/reload`, `/new`, `/resume`, `/fork`) and cached until the next one. `/reload` is how place rule and remote edits are picked up. Only the place zone is cached: account tags and the rest of the config are read live. Mid-turn model-change checks use the cached zone.

Why cache at session start instead of resolving per turn: the cwd of a pi session does not change, git calls cost time on the turn's critical path, and a remote that changes mid-session is rare. The price is that a hand edit or a `git remote` change is picked up only on `/reload` or a new session. Edits made through `/guard place` and `/guard zone` re-resolve this session's place zone at once (section 11).

## 6. Account identity

Decided in [Can an extension identify which pooled credential a request uses?](https://github.com/crisboarna/pi-account-guard/issues/3) and [Should the Account key include auth source, and how do pooled providers fail closed?](https://github.com/crisboarna/pi-account-guard/issues/9). ADR 0002.

An **Account** is the model's provider id plus its **auth source**.

- Auth source is one of `oauth`, `stored-key`, `env:<VAR>`, `models-json-key`, `models-json-command`, `runtime` or `fallback`. Two environment variable names under one provider id are two accounts. The text of a `models.json` command is never stored or shown.
- The key is built fresh at every check from pi's cached auth snapshot, with public calls that return no secrets: `isUsingOAuth` and `getProviderAuthStatus().source/label`. `/login` and `/logout` inside pi refresh the snapshot; an `auth.json` edit made outside pi is seen one refresh late.
- A source change under the same id (for example `/logout`, after which an environment key takes over) produces an untagged account, which Blocks with the tag prompt.
- The Match compares the key built from `ctx.model` with the tags. It does no registry lookup, so an account that disappears from the registry mid-session is not undecidable. Tags for accounts the registry no longer knows are kept and listed by `/guard`.
- **claude-bridge** gets a built-in resolver, because the registry only sees `apiKey: "not-used"`. If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, the source is `env:<VAR>`. Otherwise the source is `claude-config:<resolved CLAUDE_CONFIG_DIR or ~/.claude>`, so a work and a personal Claude Code config directory are different accounts. Cloud provider (Bedrock, Vertex and the others) and `apiKeyHelper` setups map to one generic `claude-code` source.
  Claude Code's precedence was read from the Claude Code 2.1.310 binary (its embedded JavaScript) and its agent SDK 0.3.309, the versions pi-claude-bridge 0.9.3 spawns (ticket #16). The bridge passes `process.env` through to the child, so the guard sees the same variables.
  1. The provider comes first. `CLAUDE_CODE_USE_BEDROCK`, `_FOUNDRY`, `_ANTHROPIC_AWS`, `_ANTHROPIC_GOOGLE_CLOUD`, `_MANTLE` and `_VERTEX` are tested in that order (a cloud gateway before all of them); the first one set wins and every `ANTHROPIC_*` credential below is then ignored. These map to the generic `claude-code` source.
  2. First-party bearer chain: `ANTHROPIC_AUTH_TOKEN`, then `CLAUDE_CODE_OAUTH_TOKEN` (or its file descriptor), then `apiKeyHelper`, then an Anthropic profile (`~/.config/anthropic`), then the saved claude.ai login under the config directory.
  3. First-party API key chain: `ANTHROPIC_API_KEY`, then a key from a file descriptor, then `apiKeyHelper`, then the key saved by `/login`.
  4. When both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are set, Claude Code builds its client with both and the code does not choose one. The resolver takes `ANTHROPIC_AUTH_TOKEN` first, the order of Claude Code's own auth-source function.
  5. `CLAUDE_CODE_OAUTH_TOKEN` is a third environment variable and gives the source `env:CLAUDE_CODE_OAUTH_TOKEN`.
  6. Claude Code also lets the `env` block of its own `settings.json` define these variables. The guard does not read that block, so a credential set there is a known gap (section 15).
  7. One narrow read is the exception (ticket #26): `<config directory>/settings.json` is parsed only to check that `apiKeyHelper` is a non-empty string. The helper command and the rest of the file are never kept, logged or shown, and a missing, unreadable or malformed file means no helper. The helper maps to `claude-code`, after the environment credentials and before `claude-config:`. The cloud gateway switch that point 1 mentions has no recorded variable name, so the resolver does not test it.
- **Pooled providers** (pi-multiprovider lifts several accounts under one provider id and leases one inside the stream, with no event). The guard detects a pool through the private `Symbol.for('pi-multiprovider.lifted-base')` marker only to warn: the tag prompt says the id pools several accounts and should be tagged only if all of them share one zone, and `/guard` lists the id as pooled. A pool alone never causes a Block. pi-multiprovider is not installed here; an upstream lease-veto hook is the future exact fix.
- The guard never reads secrets.
- **Display.** The tag prompt, Block titles and `/guard` show `<provider id> · <source in words>`, followed by any pi-multi-pass label as a hint. Examples: `openai-codex-2 · OAuth login (multi-pass: Work)`, `claude-bridge · Claude Code login ~/.claude-work`. They never show a raw key string.

Known gaps (see section 15): a re-login as a different person under the same id, a direnv-swapped key under the same variable name, an `auth.json` edit made outside pi.

## 7. Match and undecidable cases

The pure function `decide()` takes the place zone (or its failure), the account key, the config (or its failure) and the active Overrides, and returns a verdict with its cause. A **Match** holds when the place zone is one of the account's zones. An account with no tag is in the Unknown zone, which no place matches.

Undecidable cases fail closed (ADR 0001, decided in [How does the guard behave when it cannot decide?](https://github.com/crisboarna/pi-account-guard/issues/6)): the guard Blocks, names the cause, and keeps allow-once and the session Override available, so it never locks the user out.

| Situation | Behaviour |
|---|---|
| `account-guard.json` missing | Not undecidable: an empty config. No rules, so every place is in the default zone; no tags, so every account is Unknown. The first turn shows the tag prompt, and the first tag creates the file. No setup wizard; the guard is never inactive. |
| Config malformed or failing validation | Keep the last valid copy read in this session and warn once. With no valid copy yet, Block every turn and name the file and the error. The tag prompt is disabled and commands refuse to write until the file is fixed. |
| Git fails while resolving the place (binary missing, corrupt repository, timeout about 2 s) | Git runs only if some place rule has a remote condition. Walk the rules in order: if a path-only rule matches before any rule with a remote condition could apply, that rule decides. Otherwise the place is undecidable and every turn Blocks until the next `session_start`. |
| No model selected | No-op. Nothing can reach a provider and pi shows its own error. |
| The guard's own handler throws | Every handler is wrapped. On error the guard aborts (`ctx.abort()`, or `{ action: "handled" }` from `input`), notifies and logs the error in the session. Required because pi swallows hook errors and continues (section 9). |

## 8. Enforcement points

Decided in [Which pi hooks can stop a turn or a mid-turn model change before send?](https://github.com/crisboarna/pi-account-guard/issues/2), [How do pi-multi-pass restriction and rotation interact with a second guard?](https://github.com/crisboarna/pi-account-guard/issues/4) and [Should the guard check every provider request through the context hook?](https://github.com/crisboarna/pi-account-guard/issues/10).

| pi hook | Use |
|---|---|
| `session_start` | Load config, resolve and cache the place zone (section 5.4), set the footer. Fires again on `/new`, `/resume`, `/fork` and reload. |
| `input` | The turn-start gate. Stops typed prompts, steering, follow-ups and `pi.sendUserMessage` (source `extension`) in TUI, print and RPC. The only hook whose return value can veto (`{ action: "handled" }`). Must not skip `/` text: skills and prompt templates reach it unexpanded. |
| `before_agent_start` | Idle re-check. Catches an account switched while pi was idle (for example by pi-multi-pass) after `input` allowed, and turns started by `pi.sendMessage({ triggerTurn: true })` while idle. A `ctx.abort()` here stops the run before the first request. Skip nothing; check `event.messageType`. |
| `model_select` | Mid-turn model change. Evaluate `ctx.model`, not `event.model` (nested emissions make the event's model stale). Abort with `ctx.abort()` only after checking `ctx.isIdle()`; when idle there is nothing to abort and the next `input` or `before_agent_start` Blocks. |
| `agent_end` | Release the allow-once Override (section 10). |
| `ctx.ui.setStatus("guard", …)` | The footer item (section 12). |
| `pi.registerCommand("guard")` | Tag, place, zone and status commands. |

Rules for all handlers:

- Every handler catches its own errors and aborts itself (section 7). No hook fails closed by itself.
- A model switch made inside the agent's awaited event chain (for example multi-pass rotation in `agent_end`) cannot race the guard. A model change made outside the loop (RPC `set_model`, the TUI selector) can race a running turn; this is a known limit.
- `model_select` does not fire on session restore; `session_start` covers it.
- Load order is the extension array order (CLI, project local, user local, then packages in settings order); there is no priority API. The design does not depend on it, because of the `before_agent_start` re-check.

## 9. Block behaviour

Decided in [What does a Block look like in TUI, print and RPC modes?](https://github.com/crisboarna/pi-account-guard/issues/8). Mockups are on the throwaway branch `prototype/block-ux` (`prototype/block-ux-mockups.md`).

### 9.1 TUI (and RPC) at turn start

The Block is one flat `ctx.ui.select`, awaited inside the `input` handler. The title states the cause and the account; the second line gives the place and its zone. Rows, in order:

1. `Switch to <account> -> <model>  [zones]`, one per matching account.
2. `Allow once: this turn to <account>`.
3. `Allow for session: <account>`.
4. `Cancel`.

```text
BLOCKED  anthropic (oauth) is zone work
Place ~/Projects/pi/diary -> zone personal

 > Switch to openai-codex-2 (oauth) -> gpt-5.5  [personal]
   Switch to anthropic (env:ANTHROPIC_API_KEY) -> claude-sonnet-5-5  [personal, work]
   Allow once: this turn to anthropic (oauth)
   Allow for session: anthropic (oauth)
   Cancel
```

- **Matching accounts** are accounts tagged with the place's zone whose auth is configured now, listed in `accounts` file order. The Switch model is the same model id if the target account's provider offers it, else that provider's first model. The row shows the result; the notice says when the id was not offered (`model gpt-5.5 (claude-sonnet-5-5 not offered)`).
- **Undecidable cause** (invalid config, git failure, internal error): only the title changes, it names the cause (for example `cannot read account-guard.json` and the JSON path error), and there are no Switch rows because no zone can be matched. Both Overrides stay.
- **Unknown account:** the tag prompt (section 10.1) comes first. Cancel, or a tag that still gives no Match, falls to the select above.
- **After the choice.**
  - Switch or an Override: the handler returns `continue` and the same prompt is sent (no resend). Switch calls `pi.setModel` first. Notice: `Switched to openai-codex-2 (oauth), sending.`
  - Cancel: the handler returns `handled` and refills the editor with `ctx.ui.setEditorText`.
- **RPC** uses the same dialogs through `extension_ui_request` (`select`, `confirm`, `input`). No answer counts as Cancel.

### 9.2 Model change during a turn

A model change to a non-matching account while a turn runs (rotation, `/model`, router fallback):

1. `ctx.abort()`, then an error notice naming the new account and the place, for example `guard: model changed to anthropic (oauth) [work] during a turn in a personal place (~/Projects/pi/diary). Turn aborted.` The notice must say a failover was blocked, because multi-pass will just have announced "switched to".
2. Once idle, the same select opens, without Allow once (there is no prompt to resend). The previous account is the first Switch row when it matches. Allow for session stays. Cancel leaves the model as it is and the next user turn is blocked.
3. The aborted turn is not resumed automatically.

Aborting after a multi-pass rotation ends cleanly: multi-pass stops, there is no loop, the rate-limited member stays exhausted for 5 minutes and the model stays on the rejected account. Ping-pong is impossible while the guard never auto-switches.

### 9.3 Headless (print, JSON)

The turn is not sent. The message goes to stderr (stdout stays clean for piping) and the process sets `process.exitCode = 77` (ADR 0005), so scripts can tell a guard Block (77) from a model error (1). Print mode does not fail by itself: a handled `input` exits 0 with no output, so the guard must write stderr and set the code explicitly. When the Block aborts a run (a mid-turn model change or a `before_agent_start` re-check), pi print mode prints its own `This operation was aborted` and assigns exit code 1 after the extensions have shut down, which would replace 77; the guard therefore sets the code again in a `process` `exit` listener (found while building the mid-turn Block, ticket #19). stderr then carries the guard's notice and pi's aborted line.

```text
$ pi -p "summarise the diary"
BLOCKED anthropic (oauth) is zone work; this place
(~/Projects/pi/diary) is zone personal. No turn was sent.

Fix, any one of:
  pi --model <an account in zone personal>
  add a place rule if this directory belongs to zone work
    in ~/.pi/agent/account-guard.json
$ echo $?
77
```

Unknown account (no tag prompt without a UI):

```text
BLOCKED openai-codex-3 (oauth) has no zone tag; place zone is personal.
Add to ~/.pi/agent/account-guard.json accounts:
  {"provider":"openai-codex-3","source":"oauth","zones":["personal"]}
or run pi, then: /guard tag openai-codex-3 oauth personal
or set PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 for this process.
```

Undecidable Blocks name their cause in the same way (config error with file and JSON path, git failure, internal error).

In RPC, a handled prompt returns success with `disposition: "handled"` and `notify` arrives as an `extension_ui_request` event; the dialogs above are used when the client answers them.

## 10. Overrides

Decided in [How does the guard behave when it cannot decide?](https://github.com/crisboarna/pi-account-guard/issues/6), [Should the guard check every provider request through the context hook?](https://github.com/crisboarna/pi-account-guard/issues/10) and the Block ticket. Never persisted.

| Override | Scope | Confirm | Shown |
|---|---|---|---|
| **Allow once** | One turn, bound to the confirmed (account, place) pair, until that turn's `agent_end`. A mid-turn switch to another non-matching account Blocks again. | Yes/no confirm naming the account and the place zone. | Session log entry. |
| **Allow for session** | The rest of the session, bound to one account (provider id plus auth source). A later switch to another non-matching account Blocks. `/new`, `/resume`, `/fork` and `/reload` start with no Override. | None; the picker row is already deliberate. | Footer `guard OVERRIDE <account> in <zone>`; session log entry. No per-turn warning. |
| **Process Override** (`PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1`) | One headless pi process. | None. | Each turn it lets through is logged in the session, with one warning per session. |

The process Override:

- Lets through only accounts in the Unknown zone, never a tagged account that fails to Match and never an undecidable case.
- Is honoured only in print and RPC. The TUI ignores it, so exporting it from a shell profile cannot silence the tag prompt.
- Is never written to disk.

Session log entries: `guard.block`, `guard.allow_once`, `guard.allow_session`, each with account, place and zone.

### 10.1 Tag prompt

Runs inside the gate when an Unknown account is Blocked and `ctx.hasUI` is true (TUI and RPC).

- After tagging the guard checks again. On a Match the turn proceeds with no resubmit. If the new tag still does not match, or the user cancels, the normal Block follows.
- **TUI:** a checkbox list through `ctx.ui.custom()`, nothing pre-checked. **RPC** cannot render custom components: a `select` of single zones plus a "Several zones…" entry that opens an `input` for comma-separated names (validated, asked again on error). Submitting no zones asks again.
- The title states the place's zone and shows the account as in section 6: "This place is personal. Which zones does openai-codex-2 · OAuth login (multi-pass: Work) belong to?". The multi-pass label is only displayed: no reordering and no prefilled `note`.
- **Bypass nudge.** A whole-word, case-insensitive match finds a zone named in the label ("Work seat" means `work`, "Network" does not). If the chosen zones leave that zone out, the guard asks for one extra confirm.
- Disabled while the config is malformed (section 7).
- A pooled provider id gets the extra warning in section 6.

## 11. `/guard` commands and the status view

Decided in the config ticket (7) and [What does the guard show when idle, and what does /guard status list?](https://github.com/crisboarna/pi-account-guard/issues/12).

Every command takes full arguments, so it works without dialogs (RPC scripting, and print mode if pi dispatches extension commands there; check during implementation). Dialogs only fill in missing arguments. With no UI and missing arguments, the command fails with its usage.

- **Status.** Bare `/guard` prints a read-only plain-text block through `ctx.ui.notify`, identical in TUI and RPC (no overlay):

  ```text
  guard status
   Place     ~/Projects/pi/diary -> personal (rule 2: ~/Projects/pi/**)
   Account   anthropic (oauth) -> work  ✗ no Match
   Overrides session: none; allow-once: none
   Config    ~/.pi/agent/account-guard.json (valid)
   Zones     work, personal (default: personal)
   Pooled    pi-multiprovider: openai-pool (warns only)
   Untagged  openai-codex-3 (oauth)

  (edit: /guard tag | place | zone ...)
  ```

  Untagged accounts are listed here only; there is no footer count. Headless modes print nothing on success: Blocks and the once-per-session process Override warning carry the information.
- **Accounts.** `/guard tag [provider [source] [zones]]` defaults to the current model's account. `/guard untag [provider [source]]` needs no confirm (an untagged account is Unknown, which fails closed). The pickers list the known accounts: every provider id with configured auth (at its current source), plus every entry in the file; entries not configured now are marked. Changing an account's existing zones shows old to new and asks to confirm.
- **Place rules.** `/guard place add` first shows which rule decides the current place, then offers conditions taken from the place (this directory and below, one of its remotes picked from the list, or both) and a zone. The new rule goes at the top by default; a position is optional. `/guard place list` numbers the rules in file order and marks the one that decides this place. `/guard place remove <n>` and `/guard place move <n> <to>` confirm only when the edit changes this place's zone.
- **Zones.** `/guard zone add <name>`. `/guard zone remove <name>` is refused while any tag, rule or `defaultZone` references the zone, and lists those references. `/guard zone rename <old> <new>` rewrites every reference in one atomic write. `/guard zone default <zone>` confirms when the current place falls to the default and its zone would change.
- **Re-resolution.** After any place rule or zone edit made through `/guard`, this session resolves its place zone again at once. Other sessions, and hand edits, wait for the next `session_start` or `/reload`. Tag edits take effect at once everywhere, because tags are read live.

## 12. Footer

`ctx.ui.setStatus("guard", …)`, always on. It shows the place zone and the Match state; the account is not repeated because pi's model line already shows it. It is recomputed on `session_start`, `model_select`, an Override change and a config change.

| State | Text |
|---|---|
| Match | `guard personal ✓` |
| No Match | `guard personal ✗ anthropic is work` |
| Unknown account | `guard personal ? untagged` |
| Session Override | `guard OVERRIDE anthropic in personal` |
| Config invalid, last valid copy in use | `guard ! config invalid (last valid copy in use)` |
| Config invalid, no valid copy | `guard ! config invalid, turns blocked` |
| Place undecidable | `guard ! zone unknown (git failed)` |

pi-powerline-footer shows a status key only after the user adds it to `powerline.customItems` (as with the existing `subscription-status.ts`); the README must say so.

## 13. Interaction with other extensions

### 13.1 pi-multi-pass

Decided in the multi-pass ticket (4). The guard stays independent.

- Rotation by multi-pass goes through `pi.setModel`, so `model_select` fires and the guard aborts (section 9.2).
- Presets and `/subs model` in multi-pass ignore its own `allowedSubs`; the guard does not.
- Multi-pass's own guard fails open on a missing or malformed file, an empty list or a subdirectory cwd; the guard does not depend on it.
- Optional hygiene users can adopt: zone-pure multi-pass pools, and a mirrored `allowedSubs`.

### 13.2 Virtual routing models (pi-switchboard)

Decided in [Can the guard resolve a virtual routing model to its real member account?](https://github.com/crisboarna/pi-account-guard/issues/11). ADR 0004. Findings: branch `research/switchboard-routing`.

A virtual model (such as `switchboard/auto`) is its own Account in v1, tagged like any other. pi calls `route()` before every request, after `input` and `before_agent_start`, so at the guard's check points no member has been chosen and `ctx.model` is the virtual model. The member can change on retry and is re-chosen on every new user turn, and a tier's members can sit in different zones. The user must tag a virtual model only with zones in which every possible member is allowed. A static superset check or a per-request check is out of scope.

### 13.3 Other providers

- **pi-multiprovider pools:** section 6.
- **claude-bridge:** built-in auth source resolver (section 6). Its `AskClaude` tool uses Claude Code's own login and is out of scope.

## 14. Scope: what is and is not guarded

Gate points in v1: user-started turns (`input`, plus `before_agent_start` as an idle re-check and for `pi.sendMessage({ triggerTurn: true })` while idle) and model changes (`model_select` mid-turn, `session_start` for resume, fork, new and reload). Handler errors abort the turn (ADR 0001).

Not guarded in v1, and named as known limits:

- `pi.sendMessage` turns while streaming, and extension `/commands` that start work.
- Retries and virtual-model re-routing that change the physical model without an event.
- Out-of-loop model changes (RPC `set_model`, the TUI selector) racing a running turn.
- Cache warmer keep-alive requests (can be stopped with `cache_warming_decision` returning `{ action: "stop" }`; not used in v1).
- Compaction and branch summaries. They call `completeSimple` directly and never pass the `context` hook. The only veto is `session_before_compact` or `session_before_tree` returning `{ cancel: true }`, not used in v1.
- Subagent child processes and other extensions' own HTTP clients.

Why no `context` gate: the strongest gate is the `context` hook plus `ctx.abort()` (it runs before every provider request on every transport, including claude-bridge, and covers retries and continuations). It was ruled out for v1 to keep the guard's surface small and the user-visible model simple ("turns and model changes"). Adding it later is cheap, so the decision is easy to reverse and has no ADR. It is unverified that no bytes leave after an abort there, for each transport.

## 15. Known gaps

- Re-login into the same provider id as a different human account, a direnv-swapped key under the same variable name, and an `auth.json` edit made outside pi (seen one snapshot refresh late). Detecting them needs secrets (ADR 0002).
- A claude-bridge credential defined only in the `env` block of Claude Code's own `settings.json` (section 6).
- Pooled providers: the guard only warns (section 6).
- The real member behind a virtual model is not checked (section 13.2).
- Everything in section 14.

## 16. Module structure

Decided in [What is the testing strategy for the guard?](https://github.com/crisboarna/pi-account-guard/issues/13).

Pure core plus thin pi glue. Pure modules take plain data, with the git reader, the file reader and the clock injected, and import nothing from pi.

```text
src/core/                 pure, no pi imports
  account.ts              key from provider id plus auth source
  place.ts                rule matching, remote normalization, zone
  config.ts               parse and validate (file plus JSON path errors)
  decide.ts               inputs -> { verdict, cause, rows }
  messages.ts             Block, footer and headless text
src/pi/                   glue
  hooks.ts                input, before_agent_start, model_select, session_start, agent_end
  ui.ts                   select, confirm, tag prompt, footer
  commands.ts             /guard
  git.ts, fs.ts           injected readers
src/index.ts              wiring
schema/account-guard.schema.json
```

Code is erasable TypeScript (no enums, no parameter properties, `.ts` import extensions) so the same files load under jiti in pi and under plain Node in tests.

## 17. Testing

Runner: `node --test` with Node's built-in type stripping (Node 22.19 or later). Typecheck: `tsc --noEmit --strict`. Three levels:

1. **Unit** (`test/unit/**`): the pure core. Account key building, place rule matching (path glob, remote normalization, case rules, precedence), zone resolution with the default zone, Match, config validation and every error path, `decide()` for each row of the section 7 table, Block, footer and headless text, override scoping (allow once, session, process).
2. **Integration** (`test/integration/**`): a fake-pi host loading `src/index.ts` through jiti (the way pi-switchboard's `test/integration/extension.test.ts` does), driving each hook handler: `input` handled or continued, `before_agent_start` abort, `model_select` abort and the `isIdle` branch, handler-throws-abort, tag prompt flow, the `/guard` commands and their atomic write. Git remote reading runs real `git` in temp repositories: no remote, `origin`, two remotes, git missing with PATH cleared (must Block when a remote rule matters).
3. **Smoke** (`test/smoke/**`, opt-in): scripted runs of real pi with no network and no credentials, using a stub provider extension and `-ne -e <extension>`. `pi --mode rpc` with scripted `extension_ui_response` answers for the dialogs; `pi -p` for the stderr text, exit code 77 and clean stdout.

Also: a source scan that fails if a real provider or model id from the examples or fixtures appears in `src/` (as pi-switchboard does).

### 17.1 Assumed pi behaviour, to prove first

Step 1 of the build is one smoke test per item below against real pi. A failing item amends this design before more code exists. All items were run in ticket #16 (`test/smoke/assumptions.test.ts`, pi 1.4.0); none failed.

| Assumption | Check | Result |
|---|---|---|
| A throwing handler lets the turn continue (ADR 0001) | smoke | Verified. Exit 0, the reply is printed on stdout, and pi writes `Extension error (<path>): <message>` to stderr for each throw. |
| `input` can await a dialog and then return `continue` | smoke (rpc) | Verified. The turn does not start until the `select` is answered, then runs. |
| `input` returning `handled` plus `ctx.ui.setEditorText` refills the editor | smoke (rpc) | Verified. The prompt response is `disposition: "handled"`, the client gets an `extension_ui_request` with `method: "set_editor_text"`, and no turn starts. |
| `ctx.abort()` works from `model_select` mid-turn | smoke | Verified, with the model switched at `turn_start`. `ctx.isIdle()` is false in the handler and `ctx.model` is already the new model; no request reaches the provider after the abort. The aborted assistant message has `stopReason: "error"` and `errorMessage: "This operation was aborted"`, not `"aborted"`. |
| `process.exitCode = 77` survives `pi -p` for a handled `input`; after an aborted run it needs a `process` `exit` listener (section 9.3) | smoke | Verified, with a handled `input`: exit 77, empty stdout, stderr as written. |
| `setStatus` is visible in RPC | smoke | Verified: `extension_ui_request` with `method: "setStatus"`, `statusKey`, `statusText`. |
| `before_agent_start` sees an idle-time model switch and its abort is honoured | smoke | Verified. RPC `set_model` while idle fires `model_select` (`isIdle()` true, `source: "set"`); `before_agent_start` then sees the new `ctx.model`; `ctx.abort()` there sends no request to the provider. As in the line above, the aborted assistant message has `stopReason: "error"`. |
| A stub provider needs no credentials | smoke | Verified, with credential variables removed from the environment and an empty agent directory. |
| Extension commands (`/guard`) are dispatched in print mode | smoke | Verified: `pi -p "/guard status now"` runs the handler with `args` of `status now` and sends no turn. |
| claude-bridge's environment precedence for its auth source | read source | Read from the Claude Code binary; recorded in section 6. |

### 17.2 Manual checklist

- The dialogs look right in a real TUI.
- The footer item appears once placed in powerline `customItems`.
- Real pi-multi-pass rotation gives a Block plus a Switch.
- `switchboard/auto` tagged as an Account blocks and allows as tagged.
- The claude-bridge account resolves to its environment key or config directory.

## 18. Decision index

| Decision | Ticket | ADR |
|---|---|---|
| Hooks that can stop a turn | [Which pi hooks can stop a turn…](https://github.com/crisboarna/pi-account-guard/issues/2) | |
| Credential identity | [Can an extension identify which pooled credential…](https://github.com/crisboarna/pi-account-guard/issues/3) | |
| Multi-pass interplay | [How do pi-multi-pass restriction and rotation interact…](https://github.com/crisboarna/pi-account-guard/issues/4) | |
| Place rule semantics | [What are the place rule semantics?](https://github.com/crisboarna/pi-account-guard/issues/5) | |
| Cannot decide | [How does the guard behave when it cannot decide?](https://github.com/crisboarna/pi-account-guard/issues/6) | [0001](docs/adr/0001-fail-closed-when-undecidable.md) |
| Config and tag prompt | [What are the config schema and the tag prompt flow?](https://github.com/crisboarna/pi-account-guard/issues/7) | [0003](docs/adr/0003-one-global-config-file.md) |
| Account key | [Should the Account key include auth source…](https://github.com/crisboarna/pi-account-guard/issues/9) | [0002](docs/adr/0002-account-is-provider-id-plus-auth-source.md) |
| No `context` gate | [Should the guard check every provider request…](https://github.com/crisboarna/pi-account-guard/issues/10) | |
| Block UX | [What does a Block look like…](https://github.com/crisboarna/pi-account-guard/issues/8) | [0005](docs/adr/0005-exit-code-77-for-headless-blocks.md) |
| Virtual models | [Can the guard resolve a virtual routing model…](https://github.com/crisboarna/pi-account-guard/issues/11) | [0004](docs/adr/0004-virtual-model-is-its-own-account.md) |
| Idle footer and status | [What does the guard show when idle…](https://github.com/crisboarna/pi-account-guard/issues/12) | |
| Testing | [What is the testing strategy for the guard?](https://github.com/crisboarna/pi-account-guard/issues/13) | |

Derived in this document (not asked, flag if wrong): the order of Switch rows (`accounts` file order; the previous account first after a mid-turn abort); how Switch picks the target model when the id is not offered (first model of the target provider); the stderr text for undecidable headless Blocks; the status key name `guard`; the JSON Schema path; the `agent_end` release of allow-once.

## 19. Sources

- pi docs (`extensions.md`, `virtual-models.md`, `rpc.md`, `rpc-extension-ui.md`, `sdk.md`) in the pi install.
- pi-multi-pass 1.12.0 `extensions/multi-sub.ts`; pi-switchboard `DESIGN.md` and `src/runtime.ts`.
- Research notes on throwaway branches: `research/pi-hook-gating`, `research/pooled-credential-identity`, `research/multi-pass-interplay`, `research/switchboard-routing`; Block mockups on `prototype/block-ux`.
