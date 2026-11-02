# Headless use: print, JSON and RPC mode

Typed refs work in every mode. `pi -p "Review #diff"` and `pi -p "Review [ref:diff]"` mean the same, and the model gets the same `<context-ref>` block as in the TUI. What needs a person at a keyboard does not work without one.

| | TUI | Print (`-p`) and JSON | RPC |
|---|---|---|---|
| Typed `#name`, `#tag:<tag>` and `[ref:name]` expand | yes | yes | yes |
| The `#` list, the `alt+r` overlay, the one-unit Placeholder | yes | no | no |
| `/ref` output | a notice | written to stderr | a notification to the client |
| A ref that fails | the send is cancelled and the draft comes back, with the reason | a failure note in the block and a warning on stderr | a failure note in the block and a notification to the client |
| A Project command that is not approved | asks you: once, always for this definition, or deny | does not run; a failure note and a hint on stderr | the client answers the question |
| `/ref approve` | confirms in a dialog | refuses | needs the client's confirm |

## Failures

A ref that cannot be read does not stop a headless run. Its block becomes a failure note: the `error` attribute names the cause, the body is empty and `bytes` is `0`, so the model can see that the ref failed. A token that matches no ref is sent as typed and is never a failure.

## Approvals

In print and JSON mode a Project command or address that you have not approved does not run. The hint on stderr says how to approve it: run `/ref approve <name>` in a pi with a UI, or answer the question once in the TUI. There is no flag that approves everything, so a script cannot approve the refs of a repository it has just cloned.

In RPC mode the question reaches the client as an `extension_ui_request`, and the client answers with `extension_ui_response`. A dismissed question is a deny.

## `/ref` in a script

Every command takes its full arguments, so this works in a script:

```bash
pi -p '/ref add api file src/api.ts desc="The public API"'
```

The output is on stderr, not stdout, so stdout stays clean for piping. With no UI and a missing argument, a command prints its usage and changes nothing.

## pi-subagents

A foreground [pi-subagents](https://www.npmjs.com/package/pi-subagents) child cannot be told from `pi -p`, so refs in the task text the parent model writes for it expand there. A background child is skipped: pi-subagents marks it with `PI_SUBAGENT_CHILD=1`, and the package leaves its input alone.

## Exit codes

The package sets no exit code of its own. A failed ref is a failure note in the message and a warning on stderr, and pi exits as it would for any message.
