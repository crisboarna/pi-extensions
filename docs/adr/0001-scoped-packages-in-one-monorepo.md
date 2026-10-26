# Scoped packages in one monorepo

Status: accepted, 2026-10-26.

## Context

Several pi extensions will be published by the same author. The pi gallery's search covers package name, description, keywords and author, so a scope neither helps nor hurts discovery. Download counts among pi packages follow usefulness and the author's reputation, not naming: the four most installed packages are unscoped single repositories by one author, and scoped monorepos (rpiv-mono, narumiruna/pi-extensions) also reach six figures a month.

## Decision

Publish every package as `@crisboarna/<name>` from this one repository, with one npm workspace per package, each versioned and released on its own with Changesets.

## Consequences

- Every name is guaranteed and the author shows in every install line and `pi list`.
- Tooling, guardrails and test support exist once; a change to a shared protocol between packages is one commit.
- Install commands are longer than unscoped ones.
- `pi install git:` would clone the whole repository, so packages are installed from npm.
- GitHub stars accrue to one repository; each package's own link is a folder URL.
