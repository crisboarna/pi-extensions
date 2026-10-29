# pi-context-refs

Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. These rules add to the repository `AGENTS.md`.

## Code map

- `src/index.ts` registers the command; behaviour lives in named modules under `src/`.

## Status

- The design is approved and complete; the code is not written. `src/` holds only the scaffold's stub, replaced in the first build step.
- Read `DESIGN.md` before changing anything, and `GLOSSARY.md` for the words to use.

## Rules from the design

- Refs are Path, File, Snippet or Dynamic; the Placeholder is `[ref:<name>]` and resolves by name at send (DESIGN.md sections 6 and 9).
- The Placeholder depends on one TS-private pi-tui method, `segment`, behind a feature check and a contract test (ADR 0001).
- A Project library loads only in a trusted project and is confined to it (ADR 0003); a Project Dynamic Ref runs only after an Approval of its definition hash, stored outside the project (ADR 0004).
- The Expansion is stored in the user message through the `input` event (ADR 0006); a Context block carries its `bytes` length.
- `src/core/` is pure and imports nothing from pi; commands and fetches are injected.
- Build step 1 is `test/smoke/assumptions.test.ts` (DESIGN.md section 16.1).
