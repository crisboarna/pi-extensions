# Repository settings

Settings on GitHub and npmjs.com that the workflows rely on. They live outside the repository, so they are listed here; apply them once, after the first push. None of them is applied automatically.

## GitHub

- **Branch ruleset on `main`**: require a pull request with one approval from code owners; require the status checks `verify / gates`, `verify / tests`, `verify / tests on the oldest supported Node`, `verify / dependency audit`, `pull request rules` and `analyze`; require signed commits; block force pushes and deletion.
- **Merge methods**: allow squash merging and merge commits, disable rebase merging. GitHub signs the commits it creates for squash and merge commits; a rebase merge rewrites commits without a signature, which the signed-commits rule then rejects.
- **Signing key**: add `~/.ssh/id_ed25519.pub` (the key in `.github/allowed_signers`) under Settings → SSH and GPG keys as a **Signing key**, or GitHub shows the commits as Unverified.
- **Actions → General**: allow GitHub Actions to create and approve pull requests (the version pull request needs it); default workflow permissions read-only; allow only actions pinned to a full SHA.
- **Environments**: create `npm` with required reviewer `crisboarna` and deployment branch `main` only.
- **Code security**: enable Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting, and CodeQL (the workflow uploads results).
- **General**: disable wikis if unused; enable "Automatically delete head branches".

## npmjs.com

- Account: 2FA for authorization and publishing.
- Each package: trusted publisher (`crisboarna/pi-extensions`, `main.yml`, environment `npm`), "Require two-factor authentication and disallow tokens".
