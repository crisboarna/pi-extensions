---
status: accepted
---

# The Expansion is stored in the user message through an `input` transform

On send, the package rewrites the message in the `input` event so the stored user message holds the full Expansion, and a Markdown transformer collapses the tail Context blocks to one line each in the live transcript.

It is the only simple route that stores the content as a message. The model gets the Expansion in every mode, steer and follow-up included; the prompt cache stays byte-stable; compaction, HTML export and resume without the extension see the real content. The cost is that the fork selector, up-arrow after resume, the steering queue line and export show the full text, and a user message cannot be expanded on demand (`/ref sent` shows it instead).

## Considered options

- **A hidden side-car from `before_agent_start`.** Rejected: steer and follow-up lose the Expansion, and sending it from `input` costs an extra model request per message in the default queue mode.
- **The `context` event.** Rejected: nothing is stored, compaction sees only Placeholders, and the cache breaks at message 0 whenever a Dynamic Ref's output changes.
- **A visible side-car with an expandable renderer.** Rejected: the same steer gap, and ctrl+o is global.
- **Replacing the user message with a custom message.** Rejected: it breaks `/fork` and history after resume, and loses the prompt in print and JSON modes.

## Consequences

- Each extension gets one Markdown transformer; this package uses it for the collapse.
- A forked or recalled message already holds its blocks and is not expanded again.
- Other extensions that read the user message see the Expansion (open question on the map).
