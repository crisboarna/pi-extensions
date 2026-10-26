---
status: accepted
---

# One global config file, no project-level file

All guard configuration (zones, the default zone, zone tags and place rules) lives in one file, `~/.pi/agent/account-guard.json`. There is no project-level file such as `.pi/account-guard.json`. A Place's zone is the user's statement about their own disk and their own accounts. A file committed to a repository travels to other clones, other machines and other people, where that statement may be wrong. Global place rules already cover per-repository needs: a path rule for one directory, or a remote rule that catches every clone of a repository wherever it is.

## Considered options

- **An optional project file that declares the Place's zone.** This is the shape of pi-multi-pass's `.pi/multi-pass.json`. Rejected: it needs a precedence rule against global place rules, and a committed zone claim can be wrong on another machine. The user would also have two places to look when a Place resolves to an unexpected zone.
- **A project file that only narrows (it can block more, never allow more).** This is safer, but it is still a second source of truth. The accidents-only threat model gives it no job that a global rule cannot do.

## Consequences

- Every edit, including the tag prompt and every `/guard` command, goes through one file. The guard re-reads that file before each write and writes atomically, so concurrent sessions do not clobber each other's changes.
- Rule order in the global file is the only precedence. There is no merge step.
- A user who works on one repository from several machines must repeat its place rule on each machine.
