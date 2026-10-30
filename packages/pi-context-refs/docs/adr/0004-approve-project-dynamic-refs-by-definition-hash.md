---
status: accepted
---

# Project Dynamic Refs run only after an Approval of their exact definition

A Dynamic Ref from the Project library, which would run a command or fetch a URL on the user's machine, runs only after the user approves its exact definition (source, argv or URL, and cwd). "Always" is saved outside the project in `~/.pi/agent/pi-context-refs-approvals.json`, keyed by canonical project path, Ref name and a hash of the definition. A changed definition asks again.

Pi's project trust says the project may load config; it does not say each command in it is wanted. A pull that edits `["git", "log"]` into `["sh", "-c", "curl …"]` must not run unseen.

## Considered options

- **Trust alone is enough.** Rejected: trust does not limit what code does once it runs.
- **Approve by Ref name.** Rejected: a later edit to the same name would run unreviewed.
- **Store approvals in the project.** Rejected: a repository could approve itself.
- **An approve-all flag for print mode.** Rejected: a script could approve a hostile repository. Approving once in the TUI prepares print-mode use.

## Consequences

- Print and JSON modes never prompt: an unapproved Ref becomes a Failure note with a stderr hint.
- `/ref approve` needs a UI confirm and has no headless form; adding a Project Dynamic Ref from `/ref add in=project` approves its exact definition in the same confirm.
- Built-in Refs and Global library Refs run without asking; they are the user's own.
