---
status: accepted
---

# Path and Snippet expand inline; File and Dynamic become framed blocks after the message

Path and Snippet are short text, so they replace the Placeholder in the prose. File and Dynamic can be large, so each becomes one `<context-ref name kind path|source bytes …>` block after the message text, in order of first appearance, and `[ref:<name>]` stays in the prose as the reference. A Snippet is never scanned again for Refs.

The split gives the model a sentence that reads normally and a tail of separable, labelled content, which is also what lets the transcript collapse the tail without touching the prose (ADR 0006). The frame follows pi's own `<file name="…">` tag.

## Considered options

- **Everything inline.** Rejected: a 50 KB file in the middle of a sentence breaks the prose, and the transcript cannot collapse it.
- **Everything in blocks.** Rejected: `see #path` would turn into a reference to a block that only holds a path.
- **Escape `</context-ref>` in content.** Rejected: pi's own `<file>` tag does not, the content is untrusted model input anyway, and escaping would change the bytes the model reads. The declared `bytes` keeps the collapse safe.
- **Snippets that can expand other Refs.** Rejected: cycles, hidden Dynamic runs and Approval surprises.

## Consequences

- A known limit: content containing the closing tag is sent as is.
- Only the tail run of blocks is collapsed in the transcript; inline text is not.
