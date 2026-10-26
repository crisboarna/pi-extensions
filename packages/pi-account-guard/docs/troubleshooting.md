# Troubleshooting

Run `/guard` first. It prints the place and the rule that decides it, the current account and whether it matches, overrides, the config file and whether it is valid.

| Symptom | Cause | Fix |
|---|---|---|
| Every turn is blocked and the footer reads `guard ! config invalid, turns blocked` | `account-guard.json` is malformed and the guard has no earlier valid copy | `/guard` names the file, the JSON path and each error. Fix them; the guard reads the file live. |
| The footer reads `guard ! config invalid (last valid copy in use)` | The file is malformed, but an earlier valid copy exists | Same as above. Until it is fixed, the guard decides with the last valid copy and the tag prompt is off. |
| The footer reads `guard ! zone unknown (git failed)` | A place rule with a `remote` matters here and `git remote -v` failed | Check that git runs in this directory, then `/reload`. |
| A new place rule or a `git remote` change has no effect | The place zone is cached when the session starts | `/reload` or start a new session. Rules added with `/guard place add` apply at once. |
| A `path` rule does not match | The rule names a symlink alias; rules match the real path | Write the rule against the real path (`realpath <dir>`). |
| A `remote` rule does not match an SSH alias such as `github.com-acme` | SSH config aliases are not resolved | Match the alias as it appears in `git remote -v`, for example `github.com-acme/*`. |
| The same provider asks for a tag again | It is signed in through another auth source (OAuth, an environment key), which is another account | Tag that account too; `/guard` lists untagged accounts. |
| A script stops with exit code 77 | A headless run was blocked; stderr says why | Tag the account or add a place rule. For untagged accounts only, `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1` lets that process through. See [headless use](headless.md). |
| The guard text does not show with pi-powerline-footer | The preset, `layout` or `disabledSegments` leave out the extension statuses segment | Add the `guard` item to `powerline.customItems`; see [footer](footer.md). |
