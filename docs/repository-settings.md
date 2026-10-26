# Repository settings

Settings on GitHub and npmjs.com that the workflows rely on. They live outside the repository, so they are listed here; apply them once, after the first push. None of them is applied automatically.

## GitHub

- **Branch ruleset on `main`**: require a pull request with one approval from code owners, require the status checks `check (node 22.19.0)`, `check (node 24)`, `pull request rules`, `workflow lint (actionlint, zizmor)`, `secret scan (gitleaks)` and `analyze`; require linear history; block force pushes and deletion; require signed commits if you sign.
- **Actions → General**: allow GitHub Actions to create and approve pull requests (the version pull request needs it); default workflow permissions read-only; allow only actions pinned to a full SHA.
- **Environments**: create `npm` with required reviewer `crisboarna` and deployment branch `main` only.
- **Code security**: enable Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting, and CodeQL (the workflow uploads results).
- **General**: disable wikis if unused; enable "Automatically delete head branches".

## npmjs.com

- Account: 2FA for authorization and publishing.
- Each package: trusted publisher (`crisboarna/pi-extensions`, `release.yml`, environment `npm`), "Require two-factor authentication and disallow tokens".
