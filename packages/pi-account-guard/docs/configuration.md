# Configuration

## How it works

- An **account** is a provider id plus its auth source, for example `openai-codex-2 · oauth` or `anthropic · env:ANTHROPIC_API_KEY`. The same provider id on another auth source is another account.
- A **zone** is a name such as `work` or `personal`. You tag accounts with one or more zones, and **place rules** map directories (and git remotes) to a zone. A directory no rule matches gets the default zone.
- Before a turn is sent, the guard checks that the account's zones include the place zone (a **Match**). If not, or if the account has no tag, the turn is **blocked**.
- The place is the session's working directory, resolved with `realpath` when the session starts. Git is read only for remotes.

What is checked: user turns (`input`, plus a re-check in `before_agent_start`), and model changes (`model_select` during a turn, `session_start` for resume, fork, new and reload).

## The file

One file holds all configuration: `account-guard.json` in the pi agent directory (`~/.pi/agent/account-guard.json` by default). There is no project-level file. A missing file means the defaults: zones `work` and `personal`, default zone `personal`, no tags and no place rules.

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

## JSON Schema

[`schema/account-guard.schema.json`](../schema/account-guard.schema.json) describes the file, and [`examples/account-guard.json`](../examples/account-guard.json) is the example above. For editor completion, associate the schema with the file in your editor's settings (for VS Code, `json.schemas`). Do not add a `"$schema"` key to the file: the guard rejects unknown fields. A JSON Schema cannot compare fields, so two rules are checked only by the guard: a zone named in `defaultZone`, a tag or a place rule must be declared in `zones`, and no two accounts may share a `(provider, source)` pair.

The design behind these rules is in [DESIGN.md](../DESIGN.md) sections 4 to 6, and the reason for a single file is [ADR 0003](adr/0003-one-global-config-file.md).
