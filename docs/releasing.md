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

## Checks after a release

The `verify-release` job of `main.yml` reads each published version back, minutes after the publish job, with `scripts/release/verify-published.ts`:

- the git tag `<name>@<version>` is on the remote;
- npm's `latest` is this version, and the registry holds its provenance attestation (the registry can take a few minutes to show a new version, so these reads repeat every 15 seconds for up to 5 minutes);
- `npm audit signatures --include-attestations` passes on a clean install of exactly this version;
- real pi installs `npm:<name>@<version>` and lists every command in `COMMANDS` (`scripts/lib/pi-rpc.ts`) as coming from that install.

A failure opens, or adds to, one issue titled "Release verification failed" and links the run, which names the package and what is wrong. The job holds no secret and cannot publish, tag or unpublish: npm cannot take a version back, so the answer to a bad release is a new patch version. Run the same check by hand with `PUBLISHED='[{"name":"@crisboarna/pi-switchboard","version":"0.1.0"}]' node scripts/release/verify-published.ts` (add `--no-tag` outside a checkout of this repository).

A new package must have its commands in `COMMANDS` before its first release, or this check fails it; `scripts/smoke-pack.ts` uses the same list before publishing.
