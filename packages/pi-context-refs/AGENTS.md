# pi-context-refs

Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. These rules add to the repository `AGENTS.md`.

## Code map

- `src/index.ts` registers the command; behaviour lives in named modules under `src/`.

## Status

- The design is approved and complete; the feature code is not written. `src/` holds only the scaffold's stub, replaced when the feature is built.
- The pi behaviour the design relies on is proved and recorded in `DESIGN.md` section 16.1. Where pi differs from the first design (trust, the editor repaint, print-mode output), the design was amended; read it before changing anything, and `GLOSSARY.md` for the words to use.

## Tests

- `test/unit` (`npm test`), `test/integration` (`npm run test:integration`) and `test/smoke` (`npm run test:smoke`, opt-in). Coverage counts unit plus integration.
- Anything that runs real pi finds it through `PI_BIN`, else the repository's pinned `node_modules/.bin/pi`. The pty flows need `python3` and use `tools/media/run-in-pty.py` with xterm.js as the terminal.
- `test/support` holds the doubles: `stub-provider.ts` (answers locally and echoes the last user message it got, so a test asserts what the model received), `probe-extension.ts` (one scenario per run; test code, not package code), `pi-process.ts`, `pty-session.ts`, `editor-harness.ts` (a real pi-tui `Editor` with no terminal) and `segment-merge.ts` (the merge technique of ADR 0001, used by the contract test).
- `test/integration/editor-segment-contract.test.ts` guards ADR 0001 against pi upgrades. Never weaken it to make an upgrade pass.

## Rules from the design

- Refs are Path, File, Snippet or Dynamic; the Placeholder is `[ref:<name>]` and resolves by name at send (DESIGN.md sections 6 and 9).
- The Placeholder depends on one TS-private pi-tui method, `segment`, behind a feature check and a contract test (ADR 0001).
- A Project library loads only in a trusted project and is confined to it (ADR 0003); a Project Dynamic Ref runs only after an Approval of its definition hash, stored outside the project (ADR 0004).
- The Expansion is stored in the user message through the `input` event (ADR 0006); a Context block carries its `bytes` length.
- `src/core/` is pure and imports nothing from pi; commands and fetches are injected.
