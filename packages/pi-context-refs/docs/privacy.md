# Privacy, and what an approval does not cover

A ref sends what you tell it to, to the model you already use. This page says what that means, and where the package's guards stop.

## What leaves your machine

- **To the model:** the content of each ref in the message you send. Nothing is sent until you send, and a ref is read at that moment.
- **To an address:** a ref of kind `url` makes one `GET` to the address you saved, and follows up to five redirects. Nothing else in the package reaches the network.
- **Nowhere else.** There is no telemetry and no update check. A test fails if a new source file reaches the network or starts a program without the README's Data and privacy section changing with it.

## What it does not do

- **It does not redact.** A file, a command's output or a page goes to the model as it is. If a file holds a secret, so does the message. Do not save a ref for an `.env` file or for a command that prints credentials.
- **The session keeps the whole text.** The stored message holds the full content of each ref, so export, the fork selector, up-arrow after a resume and a compaction summary show it. Only the live transcript collapses it. Anything else that reads the message, such as a router or a guard, sees it too.

## What an approval covers

A command or an address in a Project library runs only after you approve its exact definition ([ADR 0004](adr/0004-approve-project-dynamic-refs-by-definition-hash.md)). The approval covers the command line and its directory, or the address. It does not cover:

- **The files a command runs.** A pull that rewrites `./scripts/x.sh`, a Makefile or `package.json` runs under the old approval, because the command line did not change.
- **The page an address returns.** It can change between two sends.
- **The environment.** A command runs with pi's whole environment, so it can read every variable pi can, including API keys. Every approval dialog says so.

Approvals live in your agent directory, never in the project, so a repository cannot approve itself.

## Where the guards stop

- **The built-in refs run `git` without asking.** In a repository you cloned, `.git/config` can make git run a program (`core.fsmonitor`, for example). Turn the built-ins off with `"builtins": false` in your Global library if you open repositories you do not trust.
- **A scope by `remote` follows `.git/config`.** A Global ref scoped to a remote appears wherever the repository names that remote, and a hostile clone can name any remote.
- **Redirects are checked by name.** A redirect from a public host to a loopback, private or link-local address is refused. The check uses the host's text and the addresses its name resolves to when it is looked up, not at the moment of connection, so a name that changes between the check and the read still wins that race. A Project library address that you approved can change in the same way.
- **Two sessions can lose a write.** If two pi sessions save a ref or an approval at the same moment, one change can be lost. A lost approval is asked for again.
- **The block markers are not escaped inside a file.** Text in a snippet or a path is escaped, so it cannot pass for a block. A file, command output or page that contains `</context-ref>` is not escaped; the block's byte length keeps the transcript right, and the model sees the raw text.
- **Refs that look like words expand.** A `#word` that matches a ref name expands, so a ref named `todo` makes every `#todo` expand.

For the full list of limits, see section 17 of [DESIGN.md](../DESIGN.md).
