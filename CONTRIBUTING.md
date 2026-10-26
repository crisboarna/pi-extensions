# Contributing

## Setup

Node 22.19 or later and npm 11.10 or later (`npm install -g npm@11`), then:

```bash
npm install
```

Install scripts of dependencies run only when listed in `package.json` `allowScripts`, and versions published in the last 3 days are refused; see [docs/conventions/dependencies.md](docs/conventions/dependencies.md). `npm install` also installs the git hooks.

## Working on a package

```bash
npm run check                 # every repository gate, all failures at once
npm test                      # unit tests of every package, plus the script tests
npm run test:integration      # each extension loaded through jiti against a fake pi host
npm run coverage              # unit tests with coverage thresholds
npm run smoke:pack            # install each package from its tarball and load it
pi -ne -e ./packages/<name>/src/index.ts   # try a package in a real pi session
```

The hooks run the fast gates on commit, check the commit message, and run everything CI runs before a push. [docs/guardrails.md](docs/guardrails.md) lists every gate and why it exists.

A new package starts from `npm run new-package -- <name> "<one-sentence description>"`; [docs/conventions/packages.md](docs/conventions/packages.md) explains what it creates.

## Pull requests

- Keep one intent per commit, with messages as in [docs/conventions/commits.md](docs/conventions/commits.md).
- Add a changeset (`npm run changeset`) when a change alters what a package publishes.
- Say in the description how you verified the change.

Releases are described in [docs/releasing.md](docs/releasing.md).
