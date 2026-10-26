# Headless use: print, JSON and RPC mode

A block in `pi -p` or JSON mode does not send the turn. The message goes to stderr (stdout stays clean for piping) and the process exits with code **77**, so a script can tell a guard block (77) from a model error (1):

```text
$ pi -p "summarize the garden beds"
BLOCKED acme (env:ACME_WORK_KEY) is zone work; this place
(~/personal/garden-planner) is zone personal. No turn was sent.
...
$ echo $?
77
```

The same holds when a block aborts a run (a mid-turn model change or an idle re-check); stderr then also carries pi's own `This operation was aborted` line, and the exit code stays 77. Over RPC there is no exit code: a blocked prompt returns success with `disposition: "handled"` and the message arrives as a `notify` request.

For an untagged account the message names the JSON entry to add:

```text
BLOCKED spare (env:SPARE_KEY) has no zone tag; place zone is personal.
Add to ~/.pi/agent/account-guard.json accounts:
  {"provider":"spare","source":"env:SPARE_KEY","zones":["personal"]}
or run pi, then: /guard tag spare env:SPARE_KEY personal
or set PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 for this process.
```

## The process Override: `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN`

Setting `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1` lets accounts with no tag, and only those, through in print, JSON and RPC mode. It never lets through a tagged account that fails to Match, and never an undecidable case (invalid config, git failure). Each turn it lets through is logged in the session, with one warning per session. The TUI ignores the variable, so exporting it from a shell profile cannot silence the tag prompt. It is never written to disk.

Why 77: [ADR 0005](adr/0005-exit-code-77-for-headless-blocks.md).
