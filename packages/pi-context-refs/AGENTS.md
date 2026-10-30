# pi-context-refs

Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. These rules add to the repository `AGENTS.md`.

## Code map

- `src/index.ts` only wires; behaviour lives in named modules under `src/`.
- `src/core/` is pure: `names.ts`, `library.ts` (parse and validate a library file), `library-state.ts` (the session's copy: re-read, last good copy, each warning once), `resolve.ts`, `tokens.ts`, `segments.ts` (merges Placeholders into one editor segment), `expand.ts` (Expansion: inline kinds, File blocks, failures), `context-block.ts` (the `<context-ref>` frame, text sanitizing, resend detection), `collapse.ts` (reads the tail run of Context blocks by their declared `bytes` and collapses each to one line).
- `src/pi/` is the glue: `editor.ts` (wraps the editor factory at `session_start` and feature-checks `segment`), `input.ts` (the `input` handler, failures per mode, where warnings show), `transcript.ts` (the Markdown transformer: user messages only), `sent.ts` (`/ref sent`) with `text-viewer.ts` (its read-only dialog), `fs.ts`.
- `/ref` (list, add, edit, remove, sent): `src/core/ref-command.ts` cuts the arguments (shell-style quoting, never a shell), `ref-edit.ts` builds and edits a Ref from `key=value` fields, `ref-list.ts` formats the list block and reads the settings, `ref-completions.ts` completes, `config-writer.ts` re-reads, changes and writes a library file; `src/pi/commands.ts` is the command, its dialogs and where its output goes.
- `schema/pi-context-refs.schema.json` describes the library files; `test/unit/schema.test.ts` keeps it in step with the loader.

## Status

- The design is approved and complete; the feature is built ticket by ticket. Built so far: the atomic Placeholder in the TUI editor, the Global library, typed `#name` and `[ref:name]` expansion of Snippet and Path Refs in every mode, and File Refs as Context blocks (text files, no caps yet) with failures per mode, and the transcript collapse of those blocks with `/ref sent`. Dynamic Refs and the File caps, binaries and images, Scoped Refs, the Project library, Built-in Refs, the picker, the editor, `/ref` and Recent refs are not built; until they are, such a token is sent as typed.
- The pi behaviour the design relies on is proved and recorded in `DESIGN.md` section 16.1. Where pi differs from the first design (trust, the editor repaint, print-mode output), the design was amended; read it before changing anything, and `GLOSSARY.md` for the words to use.
- `/ref` works on the Global library only: `in=global` is the one library it knows until the Project library and Scoped Refs are built. `approvals`, `approve` and `revoke` are not built; `sent` shows the last user message on the session branch (a read-only dialog in the TUI, notify text in RPC, stderr in print and JSON). Its output goes to `ctx.ui.notify` where there is a UI and to stderr where there is none (print and JSON); the list block is the same text in both.

## Tests

- `test/unit` (`npm test`), `test/integration` (`npm run test:integration`) and `test/smoke` (`npm run test:smoke`, opt-in). Coverage counts unit plus integration.
- Anything that runs real pi finds it through `PI_BIN`, else the repository's pinned `node_modules/.bin/pi`. The pty flows need `python3` and use `tools/media/run-in-pty.py` with xterm.js as the terminal.
- `test/support` holds the doubles: `stub-provider.ts` (answers locally and echoes the last user message it got, so a test asserts what the model received), `probe-extension.ts` (one scenario per run; test code, not package code), `pi-process.ts`, `pty-session.ts`, `editor-harness.ts` (a real pi-tui `Editor` with no terminal) and `segment-merge.ts` (the merge technique of ADR 0001, used by the contract test).
- `test/integration/input.test.ts` loads `src/index.ts` through jiti into the fake pi host (`test/support/fake-pi.ts`) with `PI_CODING_AGENT_DIR` in a temporary directory; the coverage run sets `CONTEXT_REFS_NATIVE_IMPORT=1` so V8 can map the source.
- `test/integration/editor-segment-contract.test.ts` guards ADR 0001 against pi upgrades. Never weaken it to make an upgrade pass.
- `test/integration/editor.test.ts` drives real pi-tui editors with key bytes through the package's decoration and the factory wrapper, including editor swaps; `test/smoke/placeholder-tui.test.ts` does the same in real pi in a pty.

## Rules from the design

- Refs are Path, File, Snippet or Dynamic; the Placeholder is `[ref:<name>]` and resolves by name at send (DESIGN.md sections 6 and 9).
- The Placeholder depends on one TS-private pi-tui method, `segment`, behind a feature check and a contract test (ADR 0001).
- A Project library loads only in a trusted project and is confined to it (ADR 0003); a Project Dynamic Ref runs only after an Approval of its definition hash, stored outside the project (ADR 0004).
- The Expansion is stored in the user message through the `input` event (ADR 0006); a Context block carries its `bytes` length.
- `src/core/` is pure and imports nothing from pi; commands and fetches are injected.
