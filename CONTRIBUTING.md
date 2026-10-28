# Contributing

## Setup

Node 24 for development (the version in `.node-version`; the packages support Node 22.19 and later, and CI tests both), npm 11.10 or later, Docker (knip, gitleaks, actionlint and zizmor run in pinned images), and commit signing:

```bash
git config commit.gpgsign true
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub   # also add it on GitHub as a signing key
```

Add your public key to `.github/allowed_signers`. Then:

```bash
npm install
```

Install scripts of dependencies run only when listed in `package.json` `allowScripts`, and versions published in the last 3 days are refused; see [docs/conventions/dependencies.md](docs/conventions/dependencies.md). `npm install` also installs the git hooks.

## Working on a package

```bash
npm run check                 # every repository gate, all failures at once
npm test                      # unit tests of every package, plus the script tests
npm run test:integration      # each extension loaded through jiti against a fake pi host
npm run coverage              # tests with 90% line, branch and function thresholds
npm run smoke:pack            # install each package from its tarball and load it
npm run test:e2e              # pi-switchboard from its tarball, in real pi; E2E_SERVERS=docker adds model servers
pi -ne -e ./packages/<name>/src/index.ts   # try a package in a real pi session
```

The hooks run the fast gates and a staged secret scan on commit, check the commit message, and before a push refuse unsigned commits and run everything CI runs. [docs/guardrails.md](docs/guardrails.md) lists every gate and why it exists.

A new package starts from `npm run new-package -- <name> "<one-sentence description>"`; [docs/conventions/packages.md](docs/conventions/packages.md) explains what it creates.

## Pull requests

- Keep one intent per commit, with messages as in [docs/conventions/commits.md](docs/conventions/commits.md).
- Add a changeset (`npm run changeset`) when a change alters what a package publishes.
- Say in the description how you verified the change.

Releases are described in [docs/releasing.md](docs/releasing.md).
