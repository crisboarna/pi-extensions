# FAQ

## Is a Project command safe to run?

Only after you approve it, and only for the exact definition you saw. A command or address in a project's shared library runs when you choose once, or always for that definition, and a changed definition asks again ([ADR 0004](adr/0004-approve-project-dynamic-refs-by-definition-hash.md)). The approval covers the command line or the address, not the files a command runs or the page an address returns, and a command runs with your environment. Every approval dialog says so. It is a guard against a teammate's change or a repository you did not write, not a sandbox.

## Why does a command ask me again after a `git pull`?

The approval is keyed to a hash of the definition: the command and its directory, or the address. A pull that changes either one is a different definition. A change to only the name, the description or the limits keeps the approval. Approvals are stored in your agent directory, never in the project, so a repository cannot approve itself.

## Why does the project library not load?

Pi has not trusted the project. The library loads only when pi trusts it, because a repository you have not chosen to trust must not be able to make your next message read `~/.ssh` or run a command ([ADR 0003](adr/0003-project-library-follows-trust-and-is-confined.md)). Run `/trust`, then restart pi: a saved decision applies from the next start. Its paths must also stay inside the project, after following symlinks; a ref that points outside is skipped with a warning.

## Why does my own ref win over the project's?

Only a scoped ref does. A scoped ref is your statement about exactly this repository, so it beats a file a teammate committed. An unscoped ref of yours gives way to the project's. See [Which ref wins](configuration.md#which-ref-wins) and [ADR 0002](adr/0002-scoped-over-project-over-global.md).

## Why is the content read when I send, and not when I pick?

So the model never gets a stale copy. A ref is read at send, every time. The one exception is a message you send again: its block keeps the text it had.

## Why does the transcript show one line, but export and fork show everything?

The stored message holds the full text, so that the model gets it in every mode, the prompt cache stays stable, and compaction, export and a resume without the extension see the real content ([ADR 0006](adr/0006-store-the-expansion-in-the-user-message.md)). Only the live transcript collapses it. Pi gives a user message no expand control, so `/ref sent` shows the full text of the last one.

## Why do a path and a snippet appear in my sentence, and a file after it?

A path and a snippet are short, so they replace the Placeholder in the prose. A file or a command can be large, so it becomes one labelled block after your message, and `[ref:name]` stays in the sentence as the reference ([ADR 0005](adr/0005-inline-text-kinds-and-framed-blocks.md)).

## Why does one Backspace delete the whole Placeholder?

The package makes `[ref:name]` act as one unit in the editor, so you cannot half-delete it. It relies on a private method of pi's editor ([ADR 0001](adr/0001-atomic-text-placeholder-over-private-segment.md)). If a pi upgrade or another extension removes that, the Placeholder is plain text: Backspace removes one character at a time, and the text still expands when you send. See [With other extensions](with-other-extensions.md).

## Why did a `#word` in my sentence expand?

A `#word` that exactly matches the name of a visible ref expands, whole word. A ref named `todo` makes every `#todo` expand. Rename the ref, or change the trigger to another character in [Configuration](configuration.md#settings).

## Can a ref take an argument, like `#issue=123`?

No. Every ref is fixed. Parameters would add token syntax and a way to inject text into a command or an address, so they are not in this version.

## Can I use it with `pi -p` and in scripts?

Yes. Typed refs expand in print, JSON and RPC mode. See [Headless use](headless.md).
