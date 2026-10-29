---
status: accepted
---

# The Project library follows pi's project trust and is confined to the project

The Project library (`<cwd>/.pi/pi-context-refs.json`) loads only when `ctx.isProjectTrusted()` is true, and its Path and File Refs must resolve inside the project directory after following symlinks. A Ref that points outside is a config error for that Ref and is skipped.

Pi does not gate this file itself, so the package applies the same rule pi uses for other project resources. A repository you have not chosen to trust must not be able to make your next message read `~/.ssh` or run a command.

## Considered options

- **Load it always.** Rejected: a cloned repository could put a File Ref to a secret under a friendly name.
- **A separate trust prompt of its own.** Rejected: two trust decisions for one project confuse; pi's `/trust` is the one the user already knows. Running a Dynamic Ref still needs its own Approval (ADR 0004).
- **No confinement, only trust.** Rejected: trusting a project to run its tools is not the same as letting its shared config read any file on disk.

## Consequences

- In an untrusted project `/ref` explains why the library is not loaded and points to `/trust`.
- A team that wants a shared Ref to a file outside the repository cannot; it uses a Global Ref scoped to the repository.
- Global Refs are not confined: they are the user's own.
