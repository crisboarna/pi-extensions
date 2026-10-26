# pi-account-guard

A pi extension that stops a session from sending a user turn to a model account that does not belong to the zone of the directory the session works in. A work subscription is never used by accident in a personal repository, and the other way round.

It is a guard against slips, not a security boundary. It never reads secrets, it checks the account pi is about to use, and it fails closed: when it cannot decide, it blocks. See [DESIGN.md](DESIGN.md) for the design, [GLOSSARY.md](GLOSSARY.md) for the vocabulary and [docs/adr/](docs/adr/) for the decisions.

## Install

Requires Node 22.19 or later and pi.

```sh
pi install npm:@crisboarna/pi-account-guard
```

Restart pi.

With no configuration the guard knows two zones, `work` and `personal`, uses `personal` as the default zone, and treats every account as untagged. The first time an untagged account is used, the tag prompt asks which zones it belongs to and creates the config file.

## How it works

- An **account** is a provider id plus its auth source, for example `openai-codex-2 · oauth` or `anthropic · env:ANTHROPIC_API_KEY`. The same provider id on another auth source is another account.
- A **zone** is a name such as `work` or `personal`. You tag accounts with one or more zones, and **place rules** map directories (and git remotes) to a zone. A directory no rule matches gets the default zone.
- Before a turn is sent, the guard checks that the account's zones include the place zone (a **Match**). If not, or if the account has no tag, the turn is **blocked**.
- The place is the session's working directory, resolved with `realpath` when the session starts. Git is read only for remotes.

What is checked: user turns (`input`, plus a re-check in `before_agent_start`), and model changes (`model_select` during a turn, `session_start` for resume, fork, new and reload).

## Configuration

One file holds all configuration: `account-guard.json` in the pi agent directory (`~/.pi/agent/account-guard.json` by default). There is no project-level file. A missing file means the defaults above.

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

| Field | Meaning |
|---|---|
| `zones` | Every zone. A tag or rule that names an undeclared zone is an error. `unknown` is reserved and cannot be declared. Default: `["work", "personal"]`. |
| `defaultZone` | The zone of a place that no rule matches. Default: `personal`. |
| `accounts` | One entry per tagged account: `provider`, `source` and a non-empty `zones` list. An account is either untagged (absent) or in at least one zone. |
| `places` | Place rules. File order is precedence: the first matching rule wins, so list specific rules first. |
| `note` | Optional free text on an account or a place rule. Matching ignores it. |

Place rules:

- A rule has a `path`, a `remote` or both, and a `zone`. When both are given, both must hold.
- `path` is absolute or starts with `~`. A path with no glob characters matches that directory and everything below it. Globs (`*`, `**`, `{a,b}`) are supported. Matching is case-sensitive against the real path, so a rule written against a symlink alias does not match.
- `remote` is a glob matched, case-insensitively, against the normalized `host/path` of every git remote (scheme, user and `.git` stripped, `:` replaced by `/`). SSH config aliases are not resolved. A rule with a remote condition does not match a directory with no remote, and git failing to run while such a rule matters blocks the turn.

Validation is strict and all-or-nothing: an unknown field, a duplicate `(provider, source)` entry, an undeclared or reserved zone, an empty zones list or a bad rule makes the whole file invalid. Every error names the file and the JSON path, for example `account-guard.json: accounts[3]: duplicate of accounts[1] (openai-codex-2 · oauth)`. While the file is invalid the guard uses the last valid copy if it has one, otherwise it blocks every turn, and it never writes over a malformed file.

The guard reads the file live, so tags apply at once. The place zone is cached at session start: a hand edit of `places` or a `git remote` change needs `/reload` or a new session. Edits made through `/guard` re-resolve the place zone immediately. When the guard writes the file, it spells the defaults out, writes atomically and pretty-prints with a 2-space indent.

### JSON Schema

[`schema/account-guard.schema.json`](schema/account-guard.schema.json) describes the file, and [`examples/account-guard.json`](examples/account-guard.json) is the example above. For editor completion, associate the schema with the file in your editor's settings (for VS Code, `json.schemas`). Do not add a `"$schema"` key to the file: the guard rejects unknown fields. A JSON Schema cannot compare fields, so two rules are checked only by the guard: a zone named in `defaultZone`, a tag or a place rule must be declared in `zones`, and no two accounts may share a `(provider, source)` pair.

## What a block looks like

In the TUI and over RPC a block opens one select:

```text
BLOCKED  anthropic (oauth) is zone work
Place ~/Projects/pi/diary -> zone personal

 > Switch to openai-codex-2 (oauth) -> gpt-5.5  [personal]
   Allow once: this turn to anthropic (oauth)
   Allow for session: anthropic (oauth)
   Cancel
```

- **Switch** rows list the accounts tagged with the place zone whose auth is configured now. Choosing one switches the model and sends the same prompt.
- **Allow once** lets this one turn through, after a confirm.
- **Allow for session** lets the rest of the session use this one account. The footer then shows `guard OVERRIDE <account> in <zone>`. Neither override is written to disk. Both end with the session, and `/new`, `/resume`, `/fork` and `/reload` start with none.
- **Cancel** puts the typed prompt back in the editor. Over RPC, no answer counts as Cancel.

An account with no tag is in the Unknown zone, and the **tag prompt** opens first: a checkbox list in the TUI, a select of single zones plus a `Several zones…` input over RPC. A tag that gives a Match sends the turn at once. The prompt is off while the config file is malformed.

A model change while a turn runs (rotation by pi-multi-pass, `/model`, a router fallback) aborts the turn with a notice that says a failover was blocked. Once idle, the same select opens with the previous account first and without Allow once. Cancel leaves the model as it is. The aborted turn is never resumed.

## Commands

Every command takes full arguments, so it works without dialogs. Dialogs only fill in what is missing.

| Command | What it does |
|---|---|
| `/guard` | Prints a status block: the place and the rule that decides it, the current account and its Match, overrides, the config file and whether it is valid, zones, pooled provider ids and untagged accounts. |
| `/guard tag [provider [source] [zones]]` | Tags an account. With no arguments it tags the current account. A provider alone means its current source. Zones are comma-separated. Changing the zones of a tagged account shows old to new and asks to confirm. |
| `/guard untag [provider [source]]` | Removes a tag. No confirm: an untagged account fails closed. |
| `/guard place add [path=<path\|here>] [remote=<glob>] [zone=<zone>] [at=<n>]` | Adds a place rule, at the top unless `at` says otherwise. With no `path` or `remote` it shows which rule decides this place and offers this directory, one of its remotes or both, then a zone. |
| `/guard place list` | Numbers the rules and marks the one that decides this place. |
| `/guard place remove <n>` | Removes rule `n`. Confirms only when this place's zone changes. |
| `/guard place move <n> <to>` | Moves rule `n` to position `to`. Confirms only when this place's zone changes. |
| `/guard zone add <name>` | Declares a zone. |
| `/guard zone remove <zone>` | Removes a zone. Refused, with the list of references, while a tag, a rule or `defaultZone` uses it. |
| `/guard zone rename <old> <new>` | Renames a zone and rewrites every reference in one atomic write. |
| `/guard zone default <zone>` | Sets the default zone. Confirms when this place falls to the default and its zone would change. |

`/guard` prints the same text in the TUI and over RPC, and nothing in print and JSON mode. With no UI, a command with missing arguments fails with its usage on stderr and exit code 2, and a change to the zones of an already tagged account is refused because it cannot be confirmed (untag first).

## Footer

The footer item `guard` is always on. It shows the place zone and the Match state:

| Text | Meaning |
|---|---|
| `guard personal ✓` | The account matches the place zone. |
| `guard personal ✗ anthropic is work` | No Match. The next turn is blocked. |
| `guard personal ? untagged` | The account has no tag. |
| `guard OVERRIDE anthropic in personal` | An Allow for session is active. |
| `guard ! config invalid (last valid copy in use)` | The file is malformed and a valid earlier copy is in use. |
| `guard ! config invalid, turns blocked` | The file is malformed and no valid copy exists. |
| `guard ! zone unknown (git failed)` | A remote rule matters and git failed. |

**pi-powerline-footer users:** powerline shows a status key only after you add it to `powerline.customItems`. Add the `guard` key there, or the item stays hidden.

## Headless use (print and JSON mode)

A block in `pi -p` or JSON mode does not send the turn. The message goes to stderr (stdout stays clean for piping) and the process exits with code **77**, so a script can tell a guard block (77) from a model error (1):

```text
$ pi -p "summarise the diary"
BLOCKED anthropic (oauth) is zone work; this place
(~/Projects/pi/diary) is zone personal. No turn was sent.
...
$ echo $?
77
```

The same holds when a block aborts a run (a mid-turn model change or an idle re-check); stderr then also carries pi's own `This operation was aborted` line, and the exit code stays 77. Over RPC there is no exit code: a blocked prompt returns success with `disposition: "handled"` and the message arrives as a `notify` request.

For an untagged account the message names the JSON entry to add:

```text
BLOCKED openai-codex-3 (oauth) has no zone tag; place zone is personal.
Add to ~/.pi/agent/account-guard.json accounts:
  {"provider":"openai-codex-3","source":"oauth","zones":["personal"]}
or run pi, then: /guard tag openai-codex-3 oauth personal
or set PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 for this process.
```

### The process Override: `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN`

Setting `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1` lets accounts with no tag, and only those, through in print, JSON and RPC mode. It never lets through a tagged account that fails to Match, and never an undecidable case (invalid config, git failure). Each turn it lets through is logged in the session, with one warning per session. The TUI ignores the variable, so exporting it from a shell profile cannot silence the tag prompt. It is never written to disk.

## Other extensions and providers

- **claude-bridge.** A claude-bridge model takes its account from the environment key variable that Claude Code would use (`env:<VAR>`), else from the resolved `CLAUDE_CONFIG_DIR` (`~/.claude` by default), so a work and a personal config directory are different accounts. Cloud provider and `apiKeyHelper` setups share one `claude-code` account. The guard reads `settings.json` only to check that `apiKeyHelper` is set.
- **pi-multi-pass.** Rotation goes through `pi.setModel`, so the guard catches it as a model change. The guard does not depend on multi-pass's own allow list.
- **pi-multiprovider pools.** A provider id that pools several accounts gets a warning in the tag prompt: tag it only if all of them share one zone. A pool alone never blocks.
- **Virtual routing models** such as `switchboard/auto` are tagged like any other account. Tag one only with zones in which every possible member is allowed. The member behind it is not checked.

## Known limits

The guard checks the account pi is about to use at the moments below. It does not watch every request.

Not guarded in v1:

- `pi.sendMessage` turns while streaming, and extension `/commands` that start work.
- Retries and virtual-model re-routing that change the physical model without an event.
- Out-of-loop model changes (RPC `set_model`, the TUI selector) racing a running turn.
- Cache warmer keep-alive requests.
- Compaction and branch summaries.
- Subagent child processes and other extensions' own HTTP clients.

Known gaps in account identity, because detecting them needs secrets:

- Re-login into the same provider id as a different human account, a direnv-swapped key under the same variable name, and an `auth.json` edit made outside pi (seen one refresh late).
- A claude-bridge credential defined only in the `env` block of Claude Code's own `settings.json`.
- Pooled providers: the guard only warns.
- The real member behind a virtual model.

Also: the place zone is cached at session start (a hand edit of `places` or a remote change needs `/reload`), and a rule written against a symlink alias of a directory does not match. See DESIGN.md sections 14 and 15.

## Development

The package lives in the [pi-extensions](https://github.com/crisboarna/pi-extensions) monorepo. Run `npm install` and `npm run check` from the repository root; the root supplies the pi host packages and the tooling.

```sh
npm test --workspace @crisboarna/pi-account-guard                  # unit tests on the pure core (src/core)
npm run test:integration --workspace @crisboarna/pi-account-guard  # fake-pi host loading src/index.ts through jiti
npm run test:smoke --workspace @crisboarna/pi-account-guard        # opt-in: real pi, offline, with the stub provider
```

The smoke tests run the `pi` on `PATH` (override with `PI_BIN`) with `PI_OFFLINE=1`, an empty agent directory and credential environment variables removed. `test/support/stub-provider.ts` answers every prompt locally. The checks that need a real TUI are in [docs/manual-checklist.md](docs/manual-checklist.md).

## License

[MIT](LICENSE)
