# pi-context-refs

Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. These rules add to the repository `AGENTS.md`.

## Code map

- `src/index.ts` only wires; behaviour lives in named modules under `src/`.
- `src/core/` is pure: `names.ts`, `library.ts` (parse and validate a library file), `library-state.ts` (the session's copy: re-read, last good copy, each warning once), `resolve.ts` (precedence: Scoped Ref, Project library, Global, Built-in), `scope.ts` and `glob.ts` (does a scope match here), `confine.ts` (the Project library's rules), `tokens.ts`, `collapse.ts` (the tail Context-block parser, strict about attribute order), `segments.ts` (merges Placeholders into one editor segment), `expand.ts` (Expansion: inline kinds, File and Dynamic blocks, failures; a Project library command is refused), `dynamic.ts` (a command's output as a block: limits, exit, cut, failures; the runner is injected), `url.ts` (a URL's body as a block, with the same limits and failure handling; the fetcher is injected), `builtins.ts` (the git Built-in Refs and the `builtins` setting), `context-block.ts` (the `<context-ref>` frame, text sanitizing, resend detection).
- `src/pi/` is the glue: `libraries.ts` (both libraries, trust and the Built-in Refs, for a send), `git-remotes.ts`, `editor.ts` (wraps the editor factory at `session_start` and feature-checks `segment`), `input.ts` (the `input` handler, failures per mode, where warnings show), `exec.ts` (`pi.exec` as the command runner, the git work tree check, why a command could not start), `fetch.ts` (the GET: redirects by hand, a body read only up to the cap), `running.ts` (the "running #x…" status and Esc, for commands and fetches), `transcript.ts` (the Markdown transformer: user messages only), `sent.ts` (`/ref sent`) with `text-viewer.ts` (its read-only dialog), `fs.ts`.
- `/ref` (list, add, edit, remove, sent): `src/core/ref-command.ts` cuts the arguments (shell-style quoting, never a shell), `ref-edit.ts` builds and edits a Ref from `key=value` fields, `ref-list.ts` formats the list block and reads the settings, `ref-completions.ts` completes, `ref-relations.ts` words what a Ref shadows, `config-writer.ts` re-reads, changes and writes a library file; `src/pi/commands.ts` is the command, its dialogs and where its output goes, and `ref-run.ts` is one run's libraries, trust and place.
- `schema/pi-context-refs.schema.json` describes the library files; `test/unit/schema.test.ts` keeps it in step with the loader.

## Status

- The design is approved and complete; the feature is built ticket by ticket. Built so far: the transcript collapse of the tail Context blocks and `/ref sent`, the atomic Placeholder in the TUI editor, the Global library, the Project library (trusted projects only, confined to the project), Scoped Refs and precedence, typed `#name` and `[ref:name]` expansion of Snippet and Path Refs in every mode, File Refs as Context blocks (cut at pi's read-tool caps, binary files refused, images attached) with failures per mode, typed `#tag:<tag>` Bundles, and Dynamic Refs (a command or a URL; a Project library one is refused until approvals are built) and the git Built-in Refs (`#diff`, `#staged`, `#status`, `#log`, below every saved Ref). A command Ref from the Project library is not run: it fails with a Failure note until approvals are built. The picker and Recent refs are not built; until they are, such a token is sent as typed.
- The pi behaviour the design relies on is proved and recorded in `DESIGN.md` section 16.1. Where pi differs from the first design (trust, the editor repaint, print-mode output), the design was amended; read it before changing anything, and `GLOSSARY.md` for the words to use.
- `/ref` knows `in=global`, `in=project` and (add, edit) `in=here`; edit and remove default to the library of the Visible Ref. `approvals`, `approve` and `revoke` are not built; `sent` shows the last user message on the session branch (a read-only dialog in the TUI, notify text in RPC, stderr in print and JSON). Its output goes to `ctx.ui.notify` where there is a UI and to stderr where there is none (print and JSON); the list block is the same text in both.

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
