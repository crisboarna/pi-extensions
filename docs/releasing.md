# Releasing

Packages are versioned and published independently with [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers).

## Day to day

1. A pull request that changes what a package publishes includes a changeset: `npm run changeset`, choose the package and bump, write one line for the changelog.
2. On `main`, after verification and the signature check pass, the Main workflow opens or updates a "chore(release): version packages" pull request that bumps versions and writes each `CHANGELOG.md`.
3. Merging that pull request runs the Main workflow again. It installs each package from its tarball (`npm run smoke:pack`), then publishes with provenance through OIDC, tags `@crisboarna/<name>@<version>` and creates a GitHub release. The publish job runs in the `npm` environment, which waits for the owner's approval.

## First publication of a new package

Trusted publishing is configured per package on npmjs.com, and npm needs the package to exist first.

1. Ask the owner; a first publication is an outward-facing action.
2. From a clean `main`: `npm publish --workspace @crisboarna/<name> --access public` (with npm login and 2FA).
3. On npmjs.com, package settings → Trusted publishing: GitHub Actions, repository `crisboarna/pi-extensions`, workflow `main.yml`, environment `npm`.
4. In the package settings, require 2FA and disallow tokens for publishing, so only the workflow can publish.

## Checks before any release

- `npm run check`, `npm test`, `npm run test:integration`, `npm run coverage`, `npm run smoke:pack` pass.
- The pack snapshot diff (`scripts/pack-snapshots/`) shows only intended file changes.
- The README's install line and limitations are current.
