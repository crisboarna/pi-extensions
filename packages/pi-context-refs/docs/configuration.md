# Configuration

There are two libraries and one approvals file. All three are JSON, and all three have a JSON Schema in [`schema/`](../schema), so an editor can check them as you type. [`examples/pi-context-refs.json`](../examples/pi-context-refs.json) is a library you can copy.

## The files

| File | Path | Holds |
|---|---|---|
| Global library | `~/.pi/agent/pi-context-refs.json` (in the directory `PI_CODING_AGENT_DIR` names, when set) | your own refs, and the two settings. Unscoped refs appear everywhere; scoped refs only where their scope matches |
| Project library | `.pi/pi-context-refs.json` in the project, never in a parent directory | refs for the whole team, meant to be committed. It loads only when pi trusts the project, and its paths must stay inside the project |
| Approvals | `~/.pi/agent/pi-context-refs-approvals.json` | which Project commands and addresses you approved. It is never stored in the project, so a repository cannot approve itself |

Both libraries carry `"version": 1` and a `"$schema"` link. Add the link and an editor validates the file:

```json
{
  "$schema": "https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-context-refs/schema/pi-context-refs.schema.json",
  "version": 1,
  "refs": []
}
```

The files are read again when they change on disk, so an edit takes effect at the next send. A missing file is an empty library. In a file that parses, each invalid ref is skipped on its own, with a warning that names the file and the JSON path, so one typo hides nothing else. A file that does not parse, or whose `version` is not 1, keeps the last good copy and is reported.

Relative paths in either library resolve against the directory pi started in, and `~/` expands. A global ref that points at `AGENTS.md` therefore means this repository's `AGENTS.md`, wherever pi starts.

## A ref

| Field | Applies to | Meaning |
|---|---|---|
| `name` | all | What you type after `#`. Case-insensitive; it cannot contain `:` |
| `kind` | all | `path`, `file`, `snippet` or `dynamic` |
| `path` | `path`, `file` | The file or directory |
| `text` | `snippet` | The text to send. A snippet cannot contain refs |
| `command` | `dynamic` | An argv array, run with no shell: `["git", "diff", "--staged"]` |
| `url` | `dynamic` | A plain `GET` over `http` or `https`; up to five redirects |
| `cwd` | `dynamic` command | Where it runs; defaults to the directory pi started in. Inside the project for a Project library ref |
| `max_bytes` | `file` | The most bytes to send. Default 50 KB, at most 1 MB |
| `timeout` | `dynamic` | Seconds before it is stopped. Default 10, at most 120 |
| `max_output` | `dynamic` | The most output to send. Default 50 KB, at most 1 MB |
| `description` | all | Shown in the list |
| `tags` | all | `#tag:<tag>` sends every visible ref with that tag |
| `scope` | Global library | Where the ref appears: `path` (a directory means its subtree, otherwise a glob) and/or `remote` (a git remote of the repository, as `host/path`). With both, both must match |

A command inherits pi's environment and has no `env` field. A command that exits non-zero is not a failure: its output is used and the exit code appears in the block. A command that cannot start, times out, is denied, or prints binary output is a failure. A cut at a limit is marked in the Expansion.

## Settings

Two settings sit beside `refs` in the Global library. There is no command to change them; `/ref list` shows them.

| Setting | Effect | Default |
|---|---|---|
| `trigger` | The character that opens the list. One character, and not `/`, `@`, `!` or a space. A change needs `/reload`. An invalid value is reported at session start and in `/ref list`, and the list uses `#` | `#` |
| `builtins` | `false` turns off `#diff`, `#staged`, `#status` and `#log`; a list of names turns off just those | all four on |

A saved ref with the name of a built-in replaces it. Outside a git work tree the built-ins are hidden from the list, and a typed one fails with "not a git repository".

## Which ref wins

When two refs share a name, the first of these wins:

1. a scoped ref in your Global library,
2. the Project library,
3. an unscoped ref in your Global library,
4. a built-in.

This differs from pi's own rule, where the project overrides the user, on purpose ([ADR 0002](adr/0002-scoped-over-project-over-global.md)). A scoped ref is your own statement about exactly this repository, so it is more specific than a file a teammate committed. An unscoped ref is your general default, so it gives way to the team's shared definition. `/ref list` names the refs that are hidden, and the list marks each row with its library.
