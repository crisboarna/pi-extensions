# Changesets

Every pull request that changes what a package publishes adds a changeset: run `npm run changeset`, pick the packages and the bump, and write one line a user of that package would want to read. CI fails a pull request that changes a package without one.

The release workflow turns pending changesets into a "version packages" pull request; merging it publishes. See [docs/releasing.md](../docs/releasing.md).
