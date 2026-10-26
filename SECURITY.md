# Security

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub security advisories](https://github.com/crisboarna/pi-extensions/security/advisories/new), not in a public issue. Include the package, its version, and the steps to reproduce. You will get an answer within a week.

## Supported versions

Only the latest published version of each package receives fixes.

## What the packages do

pi extensions run with your user's permissions. Each package README states what it reads, what it writes and which network calls it makes. Read it, and the source, before installing any extension.

## How releases are protected

Releases are published from GitHub Actions through npm trusted publishing, with provenance, from a protected environment. Dependency installs refuse unlisted install scripts and versions younger than 3 days. [docs/guardrails.md](docs/guardrails.md) lists every check.
