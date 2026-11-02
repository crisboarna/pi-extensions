---
name: pi-context-refs
description: Explain pi-context-refs, the named refs a user sends with #name, and propose /ref commands. Use when the user asks why a #name or [ref:name] did not expand, what a ref sends to the model, why a project command is pending, or how to save a file, snippet or command as a ref or share refs with a team.
---

# pi-context-refs

pi-context-refs lets the user save context (a path, a file, a snippet of text, or the output of a command or a URL) as a named ref, and send it by typing `#name` or picking it from a list. The editor shows `[ref:name]`; the content is read when the message is sent and added after the message in a `<context-ref>` block. Slash commands are the user's: you read files and propose commands, and the user runs them.

## Read the setup

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
cat "$AGENT_DIR/pi-context-refs.json"            # the user's library: refs, and the settings trigger and builtins
cat .pi/pi-context-refs.json                     # the project's shared library, when the project has one
cat "$AGENT_DIR/pi-context-refs-approvals.json"  # which project commands and addresses the user approved
```

The schemas are in `schema/` in the package (`$AGENT_DIR/npm/node_modules/@crisboarna/pi-context-refs/`). A missing file is an empty library. The project library loads only when pi trusts the project, and its paths must stay inside the project.

## Explain why a ref did not expand

A `#name` or `[ref:name]` is sent as typed when no visible ref has that name. Check these, in order:

1. The name is spelled as in a library. Names are case-insensitive and cannot contain `:`.
2. The library is loaded. A project library needs pi's trust (`/trust`, then a restart).
3. The ref is in scope. A ref with `scope` appears only where its `path` or git `remote` matches.
4. Another ref is not hiding it. The order is: a scoped ref, the project library, an unscoped ref, a built-in. `/ref list` names the hidden refs.
5. A project command or address shows `(pending)` until the user approves its exact definition, and asks again after any change to the command line or the address.

Done when you can say which of the five holds and what the user would see in `/ref list`.

## Propose a fix

- Save a file: `/ref add api file src/api.ts desc="The public API"`. A snippet and a command use the kinds `snippet` and `dynamic`: `/ref add terse snippet "Answer in one sentence."`.
- Share with the team: add `in=project`. The user sees the exact definition once and confirms it; nothing is saved without that.
- A ref for one repository only: `in=here`.
- See what is set up and what is hidden: `/ref list`. See what a message sent: `/ref sent`.
- A pending project command: the user sends a message that names it from the TUI and answers the question, or runs `/ref approve <name>`.

## Never

- Never approve a command or an address for the user, and never edit `pi-context-refs-approvals.json` to make one run. An approval is the user reading the definition.
- Never add a command or an address to the project library without showing its exact definition to the user first.
- Never save a ref for a file or a command that holds secrets (an `.env` file, a command that prints keys). The package does not redact what a ref sends.
- Never read or print credentials (`auth.json`, key variables).
