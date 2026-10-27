# Repository settings

Settings on GitHub and npmjs.com that the workflows rely on. They live outside the repository, so they are listed here; apply them once, after the first push. None of them is applied automatically.

## GitHub

- **Branch ruleset on `main`**: require a pull request with one approval from code owners; require the status checks `verify / gates`, `verify / tests`, `verify / tests on the oldest supported Node`, `verify / dependency audit`, `pull request rules` and `analyze`; require signed commits; block force pushes and deletion.
- **Merge methods**: allow squash merging and merge commits, disable rebase merging. GitHub signs the commits it creates for squash and merge commits; a rebase merge rewrites commits without a signature, which the signed-commits rule then rejects.
- **Signing key**: add `~/.ssh/id_ed25519.pub` (the key in `.github/allowed_signers`) under Settings → SSH and GPG keys as a **Signing key**, or GitHub shows the commits as Unverified.
- **Actions → General**: allow GitHub Actions to create and approve pull requests (the version pull request needs it); default workflow permissions read-only; allow only actions pinned to a full SHA.
- **Environments**: create `npm` with required reviewer `crisboarna` and deployment branch `main` only.
- **Pages**: under Settings → Pages, set the source to **GitHub Actions**. The `github-pages` environment it creates must allow deployments from `main` only. On a private repository Pages needs a paid plan, so the `site` job of `main.yml` is skipped until the repository is public. The site is `https://crisboarna.github.io/pi-extensions/`.
- **Code security**: enable Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting, and CodeQL (the workflow uploads results).
- **General**: disable wikis if unused; enable "Automatically delete head branches".

## npmjs.com

- Account: 2FA for authorization and publishing.
- Each package: trusted publisher (`crisboarna/pi-extensions`, `main.yml`, environment `npm`), "Require two-factor authentication and disallow tokens".

## First release

npm can configure a trusted publisher only for a package that already exists, so each package's first version is published from CI with a short-lived token. Doing it from CI, not by hand, gives the first versions the same provenance, release tags, GitHub releases and GitHub Packages copies as every later one.

1. Make the repository public; npm refuses provenance from a private repository. Apply the GitHub settings above that wait for it (rulesets, the `npm` environment, Pages).
2. On npmjs.com, create a granular access token: read and write on the `@crisboarna` scope, "bypass two-factor authentication" (CI cannot answer a 2FA prompt), expiry 1 day. Store it as the secret `NPM_TOKEN` in the `npm` environment, not at the repository level.
3. Merge the version pull request ("chore(release): version packages") and approve the `publish to npm` job. npm tries trusted publishing first, finds no publisher for a new package, and uses the token; Changesets then pushes a tag and creates a GitHub release for each package, and the next steps attest the packed files (SLSA build provenance, checked with `gh attestation verify <file>.tgz --repo crisboarna/pi-extensions`) and publish them to GitHub Packages.
4. For each package on npmjs.com, add the trusted publisher and set "Require two-factor authentication and disallow tokens" (the npmjs.com list above).
5. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. Every later release uses trusted publishing only.
6. On GitHub, open each package under the repository's Packages and check that it is linked to `crisboarna/pi-extensions` and public; packages published by a workflow are linked to its repository and normally take its visibility.

A package added to the repository later needs steps 2 to 5 again for its first version.
