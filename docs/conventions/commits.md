# Commit messages

```text
<type>(<scope>): <subject>

<body: what changed and why, wrapped prose>
```

- **type**: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` or `revert`. Add `!` after the scope for a breaking change.
- **scope**: a package folder name (`pi-switchboard`) or a repository area: `repo`, `deps`, `release`, `ci`, `docs`, `scripts`. Leave it out when a change spans everything.
- **subject**: imperative, lower-case first word, no final period; the whole header stays within 100 characters.
- **body**: optional; explain why, not how. Wrap prose; do not use bullet lists for a single point.
- No AI attribution: no `Co-Authored-By` trailer for an assistant and no "Generated with" line.

`scripts/checks/commit-msg.ts` enforces these rules in the commit-msg hook and, for every commit in a pull request, in CI.

Examples:

```text
feat(pi-switchboard): read account quota from pi-usage for the quota strategies
fix(pi-switchboard): honour a tier's cooldown.defaultMs for rate-limited members
build(deps): bump the pi host packages to 1.5.0
ci: pin zizmor to v0.9.0
```
