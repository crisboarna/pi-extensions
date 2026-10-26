---
name: new-extension
description: Create a new pi extension package in this monorepo and take it to a releasable state. Use when the user asks for a new extension or package here.
---

# New extension

1. Agree the name (`pi-<word>`), the one-sentence description and what the first version does. Ask if any of them is unclear.
2. Run `npm run new-package -- <name> "<description>"`. It creates `packages/<name>` with a passing test, README, AGENTS.md and pack snapshot, and runs `npm install`.
3. Add the package to the table in the root `README.md`.
4. Write the behaviour test-first: put logic in named modules under `src/`, keep `src/index.ts` to registration, and test the modules with `node --test`. Read `docs/conventions/packages.md` and the pi runtime rules in `AGENTS.md` before touching pi APIs.
5. Read pi's extension docs from the installed release (`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`) for every API you call; do not guess signatures.
6. Fill in the README by `docs/conventions/readme.md`, including Limitations.
7. Run `npm run check`, `npm test`, `npm run coverage`, `npm run smoke:pack`, then verify live with the `verify-extension` skill.
8. Add a changeset (`npm run changeset`, minor for a first feature release) and commit with `feat(<name>): …`.
9. Stop before publishing: a package's first publication is manual and needs the user (see `docs/releasing.md`).
