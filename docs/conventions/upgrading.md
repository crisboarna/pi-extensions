# Upgrade notes

Every package has a `docs/upgrading.md`. A person who already uses the package reads it before they upgrade, so it answers two questions: what survives an upgrade, and what they must do when a release breaks something.

Link it from the README's Reference section. Write it in the same plain English as the rest of the documentation: short sentences, active voice, one term for one thing.

## What an upgrade keeps

One short section. For each thing the package keeps on the person's machine, say where it is, which version wrote it, and what the new version does with an old one.

- Files the package writes (the configuration, the libraries, the approvals file): the path, the format version, and whether an old file is read as it is, migrated, or refused with a message.
- Choices the person made (an approval, a tag, a tier): whether an upgrade keeps them, and what makes one ask again.
- What the package does when it cannot read an old file. Say whether it fails closed, falls back, or stops, because that is the sentence people look for.

## How breaking changes are announced

A breaking change is a major release. It needs both of these, and the changeset must be marked `major`:

1. A changeset that says what broke, in one sentence the person can act on.
2. A section in the package's `docs/upgrading.md` headed with the version, `## 2.0`, that gives the old behaviour, the new behaviour and the exact edit to make (a command, or a before and after of the file).

Write a per-version section only when a major release ships. Before then the file holds the first section and one line saying that no release has broken anything yet; do not invent migration notes for changes that have not happened.

## Where the pi version fits

The pi range a package supports is `PI_PEER_RANGE` in `scripts/lib/repo.ts`, tested by CI at its floor and at its newest release. Raising the floor or the ceiling changes what a package supports, so it needs a changeset and a line here saying which pi versions the release works with.
