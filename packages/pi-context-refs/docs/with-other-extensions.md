# With other extensions

The package touches three things other extensions also touch: the editor, the message you send, and the transcript.

## The editor

A Placeholder is plain text that the package makes act as one unit, by wrapping the editor that is in pi's editor slot ([ADR 0001](adr/0001-atomic-text-placeholder-over-private-segment.md)). Several extensions replace the editor, so the package waits one tick after `session_start`, when every extension has installed its own, and wraps the last one ([ADR 0007](adr/0007-wrap-the-editor-one-tick-after-session-start.md)). Load order does not decide who wins.

What is tested, with one Backspace on a typed Placeholder, loaded before and after the package:

| Extension | Version | Result |
|---|---|---|
| pi's `rainbow-editor` example | the pi under test | one unit |
| [pi-cc-steer](https://www.npmjs.com/package/pi-cc-steer) | 0.1.10 | one unit |
| [pi-image-view](https://www.npmjs.com/package/pi-image-view) | 0.5.0 | one unit |
| [pi-powerline-footer](https://www.npmjs.com/package/pi-powerline-footer) | 0.21.0 | one unit |

The last three are real packages, installed by `npm run coexist` into a temporary folder and loaded into real pi; the pins are in [`scripts/coexist.json`](https://github.com/crisboarna/pi-extensions/blob/main/scripts/coexist.json). A newer version of one of them is not tested until its pin moves.

Not tested by a person yet: [pi-up-history](https://www.npmjs.com/package/@richardgill/pi-up-history) and [pi-multi-pass](https://www.npmjs.com/package/pi-multi-pass). See [the manual checklist](manual-checklist.md).

### When the Placeholder is plain text

An extension that replaces the editor later than that one tick, and does not wrap the editor it replaces, removes the decoration. Backspace then deletes one character at a time. Nothing else changes: the text is still `[ref:name]` and it still expands when you send, and `alt+r` works as before. A test in the repository pins this case with an extension that swaps the editor after 100 ms.

A pi upgrade can also turn the Placeholder into plain text, because it relies on a private method of pi's editor. A test checks that method on every build, and the plain text still expands.

## The message

The stored message holds the full Expansion ([ADR 0006](adr/0006-store-the-expansion-in-the-user-message.md)). Anything that reads the message sees the full text, not the Placeholder: a router, a classifier or a guard that looks at what you sent; the fork selector and the editor after a fork; up-arrow after a resume; the steering queue line; HTML export; and a compaction summary. Only the live transcript collapses the blocks.

If an extension must not see a ref's content, do not send that ref in a message it reads.

## The transcript and completions

Pi gives each extension one Markdown transformer, and the package uses it to collapse the context blocks to one line each. Another extension's transformer runs beside it.

`@` file completions only see files that appeared in sent text, so a path used only through `bash` or `ls` is not offered.

## pi-subagents

A foreground [pi-subagents](https://www.npmjs.com/package/pi-subagents) child cannot be told from `pi -p`, so refs in the task text the parent model writes for it expand there. A background child is skipped. See [Headless use](headless.md).
