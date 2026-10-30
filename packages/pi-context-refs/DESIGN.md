# pi-context-refs design

Status: **approved 2026-10-29**. Terms in bold are defined in [GLOSSARY.md](GLOSSARY.md). The hardest decisions have ADRs in [docs/adr/](docs/adr/). This document is the destination of the wayfinder map [Map: design spec for pi-context-refs](https://github.com/crisboarna/pi-extensions/issues/162); every section names the ticket that decided it. Section 19 lists what this document adds or settles beyond the tickets.

## Summary

pi-context-refs is a pi extension that lets you save named **Refs** (a path, a file, a snippet of text, or the output of a command or URL), pick one in pi's editor, and send it as a compact **Placeholder** that becomes real content when the message goes out.

- A **Trigger** key (`#`) opens a picker of saved Refs and **Recent refs**. A pick inserts a Placeholder such as `[ref:api]`.
- When the message is sent, each Placeholder is replaced by its **Expansion**. The model gets the full content; the live transcript shows a compact line per File or Dynamic Ref.
- Refs live in a **Global library** (yours) and a **Project library** (shared with a repository's team, only in a trusted project). A project Dynamic Ref runs only after your **Approval**.
- The picker and the atomic Placeholder are TUI-only. A typed `#name` or `[ref:name]` expands in every mode (TUI, print, JSON, RPC).

```text
editor:  #  ─▶ picker (inline list, or alt+r overlay) ─▶ [ref:api] [ref:diff] in the draft
send:    input event ─▶ find tokens ─▶ resolve (Visible Refs, Recent paths)
                      ─▶ Path/Snippet: text in the prose
                      ─▶ File/Dynamic: <context-ref …> blocks after the prose
                      ─▶ failure: TUI cancels and restores the draft; other modes send a failure note
model:   receives the full Expansion        transcript: one line per block (Markdown transformer)
```

## 1. Goals, non-goals, threat model

Goals:

- Make reusing context cheap: save it once, insert it with a few keys, never retype a path or paste a log.
- Keep the draft readable: a Placeholder is short and names what it stands for.
- Send the right thing: content is read at send, so it is current, and the stored message holds exactly what the model saw.
- Work in every mode: typed refs expand in print, JSON and RPC too.

Threat model (settled in [How do Dynamic refs run, and what stops one doing harm?](https://github.com/crisboarna/pi-extensions/issues/170)): a Project library you did not write (a teammate's change or a hostile repository) running commands or fetches on your machine, or starting runs you did not intend. Output is untrusted model input, like any file's contents, and is not filtered. The model cannot trigger a Ref: only user input expands.

Non-goals (v1):

- Extending or depending on `@zigai/pi-mention-anything`. This is a standalone package that borrows its ideas.
- Clipboard as a Dynamic source: ctrl+v already does it, and pi exports no clipboard reader.
- Parameters for Dynamic Refs (for example `#issue=123`). v1 Refs are fixed; parameters would add token syntax and an injection and exfiltration surface.
- Reading earlier sessions for Recent refs, and writing anything to remember Recent refs.
- Presentation work (README front door, media, site entry): the package follows the family conventions when it is built.
- Everything in section 18.

## 2. Prior art and why a new package

Surveyed while charting, against pi 1.4.0. About 2,750 unique `pi-package` npm packages, about 570 more from text searches and 17 pi.dev gallery queries were scanned. None matches.

| Package | What it has | What it lacks |
|---|---|---|
| `@zigai/pi-mention-anything` 0.2.0 | configurable trigger, chained pickers, expansion in the `context` event | atomic placeholder, built-in file-contents refs, commands to manage refs, project storage; global JSON only; the transcript keeps the raw token |
| `pi-simple-snippets` | `%` trigger, text only, `input`-event expansion in every mode | every other kind, an atomic marker |
| `@zigai/pi-mention-project` | `#`, project directories | saved Refs, expansion of content |
| `@bacnh85/pi-references` | saved paths, `/refs` | content, picker |
| `pi-mentions` | `#`, git and GitHub | saved Refs |
| `pi-image-view` | atomic `[Image #N]` through private editor internals | refs |
| `@xynogen/pix-display` | display-only chips | refs |

`#` is one of pi-tui's default trigger characters and pi's own provider ignores it, but four packages and pi's `github-issue-autocomplete.ts` example claim it; `$ % & +` are free. Section 4 says how this package coexists on `#`.

## 3. Concepts

See [GLOSSARY.md](GLOSSARY.md): **Ref**, **Ref kind**, **Source**, **Built-in Ref**, **Tag**, **Bundle**, **Ref library**, **Global library**, **Project library**, **Scoped Ref**, **Visible Ref**, **Shadowed Ref**, **Approval**, **Trigger**, **Recent ref**, **Placeholder**, **Expansion**, **Context block**, **Failure note**. This document uses those words and no synonyms.

## 4. Names and the trigger

Decided in [What is the package called, and what are its trigger key, command and config names?](https://github.com/crisboarna/pi-extensions/issues/166).

- Package `pi-context-refs`, published as `@crisboarna/pi-context-refs`. Every file, session entry and message type the package owns uses the stem `pi-context-refs` (`~/.pi/agent/pi-context-refs.json`, `pi-context-refs-approvals.json`, entries `pi-context-refs.*`), as pi-switchboard does.
- Command `/ref` with subcommands (section 14). Pi has no built-in `/ref`, and the name avoids `/refs`, which `@bacnh85/pi-references` uses. The scaffold's placeholder command `/context-refs` is replaced.
- **Trigger**: `#` by default, set by one global `trigger` setting: a single character, never `/`, `@`, `!` or whitespace (pi drops `/` and whitespace as trigger characters; `@` and `!` are pi's files and bash). It is global, not per project, so the key is the same in every repository. A change needs `/reload`.
- **Coexisting on `#`**: a bare `#` opens the picker. `#text` is claimed only when some Ref or Recent ref matches it. Purely numeric tokens (`#123`) and tokens with no match go down the provider chain to other `#` providers (`addAutocompleteProvider`; the last registered is asked first). `# heading` opens nothing, because the space ends the token.
- **Typed ref token**: a whole-word `#name` expands only when it exactly matches a Visible Ref's name, case-insensitively. `#1 priority`, `issue #42` and `#unknown` pass through unchanged.
- **Names of Refs**: letters, digits, `.`, `-` and `_`, the characters pi's editor keeps filtering on as you type. A name that ends in `.` is a config error, so every name can be typed. Two names that differ only by case are a config error.

## 5. Refs and libraries

Decided in [What is a Ref, and where does the Ref library live?](https://github.com/crisboarna/pi-extensions/issues/167); Dynamic fields from [How do Dynamic refs run, and what stops one doing harm?](https://github.com/crisboarna/pi-extensions/issues/170).

### 5.1 A Ref

| Field | Meaning |
|---|---|
| `name` | see section 4 |
| `kind` | `path`, `file`, `snippet` or `dynamic`, fixed when saved. A typed `#name` needs exactly one meaning; saving the same file as `#api` (File) and `#api-path` (Path) is cheap |
| `path` | target of a Path or File Ref |
| `text` | target of a Snippet |
| `command` or `url` | the **Source** of a Dynamic Ref (section 10): `command` is an argv array, `url` an http or https URL; exactly one |
| `cwd` | Dynamic `command` only, optional; resolves like Ref paths |
| `max_bytes` | File only, optional, raises the cut (section 9.4) up to 1 MB |
| `timeout`, `max_output` | Dynamic only, optional, raise the defaults up to 120 s and 1 MB. `max_bytes` and `max_output` are whole numbers of bytes, `timeout` a whole number of seconds |
| `description` | optional, shown in the picker |
| `tags` | optional list; same characters as names, case-insensitive |
| `scope` | Global library only, optional (section 5.3) |

A library file is `{ "version": 1, "$schema": "…", "refs": [ … ] }`. `schema/pi-context-refs.schema.json` describes it and every field above; a Ref may carry only the fields its kind uses, and a field this version does not know skips that Ref, so a typo is reported rather than ignored. Keys outside `refs` that this version does not read (the settings of section 10.2 among them) are left alone.

### 5.2 The two libraries

- **Global library**: `~/.pi/agent/pi-context-refs.json`. Unscoped Refs appear everywhere; Scoped Refs only where their scope matches. Personal repository-specific Refs live here, so nothing personal has to be committed. It also holds the global settings `trigger` and `builtins` (section 10.2).
- **Project library**: `<cwd>/.pi/pi-context-refs.json`, exactly where pi reads project config and never in a parent directory. It is meant to be shared and committed. It loads only when pi trusts the project (`ctx.isProjectTrusted()`); in an untrusted project `/ref` says why and points to `/trust`, and says that a saved decision applies from the next start of pi, because `/trust` does not change a running session (section 16.1). Pi does not gate this file itself. Pi treats a project as trusted when it has no trust-requiring resource (a `.pi/settings.json`, `mcp.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md` or `APPEND_SYSTEM.md`, or a `.agents/skills` directory), so a repository whose only `.pi` file is `pi-context-refs.json` loads its Project library with no decision from the user. Trust is then not what protects the user: the Approval (section 10.3) and the confinement rule below are. Its Path and File Refs must resolve inside the project directory after following symlinks; anything outside is a config error for that Ref. ADR [0003](docs/adr/0003-project-library-follows-trust-and-is-confined.md).
- Relative paths in either library resolve against the session's working directory, so a global `#agents` pointing at `AGENTS.md` means this repository's `AGENTS.md` wherever pi starts. `~/` expands.
- Both files carry `"version": 1` and a `"$schema"` link (as pi-switchboard's do), and are re-read when they change on disk, checked when the picker opens and before a send.

### 5.3 Scope

A Scoped Ref has an optional `scope` with a `path` (a bare directory means its subtree, otherwise a glob) and/or a git `remote` (any remote of the cwd's repository, normalized to `host/path`, case-insensitive). Both given means both must match. If git fails, a remote-scoped Ref does not appear. This is the same meaning as pi-account-guard's place rules, reimplemented here and not imported (packages never depend on each other).

### 5.4 Precedence

The same name in several places: **Scoped Ref > Project library > unscoped Global Ref > Built-in Ref**. Within one file the first matching Ref with that name wins. The picker marks each row's layer, and `/ref` lists **Shadowed Refs**. ADR [0002](docs/adr/0002-scoped-over-project-over-global.md): this order differs from pi's own "project overrides user" rule.

### 5.5 Missing or malformed files

A missing file is an empty library. In a file that parses, each invalid Ref is skipped on its own, with one warning naming the file and the JSON path, so one typo does not hide the rest; a Ref whose name repeats an earlier one in the file, compared case-insensitively, is skipped the same way. A file that does not parse, or whose `version` is not 1, keeps the session's last good copy (or none). Warnings show once in the TUI, in `/ref`, and on stderr in print mode.

### 5.6 Bundles

`#tag:<tag>` (Ref names cannot contain `:`, so there is no clash) means every Visible Ref carrying that tag, ordered scoped, project, global, then file order. Picking a Bundle inserts one Placeholder per member, so each can be removed before sending, and only for members not already in the draft. A typed `#tag:<tag>` expands to all members at send, each as it would be on its own: a Snippet or Path inline where the token stood, a File as a Context block after the text (the token adds no text for it), once for a member the message also names or already carries a block for. A Dynamic member keeps every Dynamic rule: a Bundle never skips an Approval.

## 6. The Placeholder and the editor

Decided in [How do the picker and the Placeholder look and behave in the editor?](https://github.com/crisboarna/pi-extensions/issues/168), after trying the prototype (branch `prototype/pi-context-refs/editor`) in real pi 1.4.0. Evidence for the routes: [How do existing pi packages draw atomic markers and chips in the editor?](https://github.com/crisboarna/pi-extensions/issues/163).

- **Route: atomic text.** The Placeholder is plain text, made atomic by merging it into one segment on top of pi-tui's own `Editor.prototype.segment`, so pi's `[paste #N]` markers stay atomic too. The package decorates whatever editor `getEditorComponent()` returns, rather than taking the editor slot. That one TS-private method is the only private dependency (ADR [0001](docs/adr/0001-atomic-text-placeholder-over-private-segment.md)). It is feature-checked; if it is missing, or another extension later replaces the editor without wrapping it, the Placeholder stays plain text that still expands on send.
- **Rejected:** the paste-store route (its content is lost on an editor swap or `setEditorText`; the buffer, history and external editor show `[paste #N …]`) and the plain `#name` token (not atomic).
- **Label: `[ref:<name>]`.** It has no spaces, so Ctrl+W after it does not also delete the word before it; it has no `#`, so it does not re-trigger `#` autocomplete; and it says which Ref it is.
- **Self-describing.** A `[ref:<name>]` in the text resolves by name against the Visible Refs when you send, like a typed `#name`, and needs no registry. Undo, Up-arrow history recall, copy and paste, and an editor swap all keep a working Placeholder. A `[ref:<name>]` that matches no Visible Ref is sent unchanged.
- **Bracket boundary.** Inside `[ref:` … `]`, only `]` ends the Placeholder, so the path forms in section 11 work. The name-character and trailing-`.` rules of section 9.5 apply to typed `#name` tokens only. Settled while assembling (section 19).

## 7. The picker

Same ticket as section 6.

- **Inline on the Trigger.** `#` opens pi's own autocomplete list. Rows are kept together by section (scoped, project, global, recent, bundles; relevance order within a section). Each row shows a layer mark (◆ scoped, ■ project, ● global, ↺ recent, ⧉ bundle, with Built-in Refs marked as built-in), the name, the kind and the description.
- **Overlay on `alt+r`.** A sectioned overlay with a filter and a preview of the selected Ref's Expansion. Picking from it after a typed `#` replaces that `#`. In the overlay you can also save a Recent row and edit or remove a saved row (section 14).
- **Tags** group and narrow the rows. Picking a Bundle inserts one Placeholder per member (section 5.6).
- Built-in Refs are hidden outside a git work tree.
- **Matching.** A row answers `#text` when the text is part of its Ref name or one of its Tags, or part of a Bundle's Tag (`#tag:<tag>` asks for Bundles only). Better matches (the whole name, then its start, then any part of it, then a Tag) come first within a section.
- **Config errors.** A `trigger` that is not one character, or is `/`, `@`, `!` or whitespace, is reported as a warning at session start and in `/ref list`, and the picker uses `#`.

## 8. Sending: the `input` handler

The package handles pi's `input` event, which fires in every mode and whose returned text becomes the stored message.

1. Find tokens: `[ref:…]` Placeholders and typed `#name` and `#tag:<tag>` tokens (section 9.5). Skip any whose `<context-ref name=…>` block already sits in the text (section 13).
2. Resolve each against the Visible Refs; a Recent ref's Placeholder resolves by path (section 11). Tokens that match nothing stay as typed.
3. Read every needed content now: files, commands, URLs. Dynamic Refs in one message run in parallel; a Ref that appears twice runs once. The TUI shows a "running #x…" status and Esc cancels the send and puts the draft back.
4. Build the Expansion (section 9), returning `text` and any `images`. On a failure, section 12 applies.

Every kind is read at send, never at pick. A steer or follow-up message reads its Refs when it is sent.

## 9. Expansion

Decided in [What does each static ref kind (Path, File, Snippet) expand to, and when is its content read?](https://github.com/crisboarna/pi-extensions/issues/169). ADR [0005](docs/adr/0005-inline-text-kinds-and-framed-blocks.md).

### 9.1 Placement

- **Path**: replaced inline by path text. Relative to the session cwd when the target is inside it, absolute otherwise (`~` expanded). Existence is not checked, because a Path may name a file you are about to create. Project library confinement still applies.
- **Snippet**: replaced inline by its saved text, literally. The text is never scanned again for `#name` or `[ref:…]`, so a Snippet cannot pull in other Refs. That rules out cycles, hidden Dynamic runs and Approval surprises; use a Tag and a Bundle to group Refs.
- **File and Dynamic**: one **Context block** per Ref after the message text, in order of first appearance, separated from the prose by a blank line. `[ref:<name>]` stays in the prose as the reference.

### 9.2 The Context block

One XML-style element for every block kind, after pi's own `<file name="…">` tag:

```text
<context-ref name="api" kind="file" path="src/api.ts" bytes="1834" truncated="50 KB">
…content…
</context-ref>
```

- Attributes, in order: `name`, `kind`, then `path` (File) or `source` (Dynamic: the argv or the URL), then `bytes`, then optional `exit` (Dynamic, non-zero only), `truncated` and `error` (failure notes, with an empty body).
- `bytes` is the exact length in UTF-8 bytes of the body, not counting the newline after the opening tag or the one before the closing tag. It is `0` for an empty body, an image and a Failure note. Section 13 reads it. Added while assembling (section 19).
- Content is raw: BOM removed and control characters stripped, otherwise byte for byte. An empty file gives an empty block.
- Content that contains `</context-ref>` is not escaped, as in pi's `<file>` tag. Under the threat model the content is untrusted model input anyway, and the model cannot trigger a Ref. This is a known limit (section 17). The `bytes` length keeps the transcript collapse correct regardless.
- Dynamic blocks add one line inside the block naming the source, a non-zero exit code, and "truncated at N KB" when the output was cut. A File-form Recent ref's `name` is its path.

### 9.3 Duplicates

- Picking a Bundle inserts Placeholders only for the members not already in the draft.
- At send, a File or Dynamic Ref used more than once gives one block (a Dynamic Ref also runs once).
- Path and Snippet are inline text, so they expand at every occurrence.

### 9.4 File limits

- By default a File is cut at 50 KB or 2000 lines, whichever comes first. These are pi's read-tool caps (exported `truncateHead`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`). The block is marked `truncated`, and a closing line tells the model it can read the rest with the read tool from line N. The closing line reads `[Truncated at 2000 lines: showing lines 1-2000 of 2500. Use the read tool with offset=2001 to read the rest.]` (the cap that was hit is `50 KB` or `2000 lines`, and it is also the value of `truncated`). A per-Ref `max_bytes` replaces the byte cap, up to 1 MB, and lifts the line cap. A cut never blocks the send.
- An image of a type pi supports (`detectSupportedImageMimeTypeFromFile`, exported) is attached through the `input` event's `images`, with an empty block naming it. It is not resized, because pi's `processImage` is not exported. Over 5 MB is a failure that suggests resizing.
- Any other binary file (a NUL byte in the first 8 KB) is a failure, never mojibake.
- A missing or unreadable file, a directory, or a target outside the project after following symlinks is a failure (section 12). A directory's message suggests a Path Ref or a Dynamic `["ls", …]` Ref.

### 9.5 Typed tokens

A typed `#name` ends at the first character that is not a name character (letters, digits, `.`, `-`, `_`), and a trailing `.` is never part of it: `#terse,` gives `terse`, and `#readme.md.` gives `readme.md`. It starts only at the beginning of the text or after a character that cannot belong to a word, URL or path, so `page#api`, `src/#a` and `C#sharp` pass through. A `[ref:…]` Placeholder is bounded by its `]` (section 6) and must close on the line it opens on.

## 10. Dynamic Refs and Approvals

Decided in [How do Dynamic refs run, and what stops one doing harm?](https://github.com/crisboarna/pi-extensions/issues/170). ADR [0004](docs/adr/0004-approve-project-dynamic-refs-by-definition-hash.md).

### 10.1 Sources

- **command**: an argv array (`"command": ["git", "diff", "--staged"]`), run through `pi.exec` with no shell. A pipe needs an explicit `["sh", "-c", "…"]`, so a reader can see that a shell runs. It runs in the session cwd, or in an optional per-Ref `cwd` that resolves like Ref paths (confined to the project for Project library Refs). It inherits pi's environment; there is no `env` field.
- **url**: a plain GET over http or https, following up to 5 redirects. Text, JSON and Markdown bodies are used as they are, HTML is inlined raw up to the cap, and a binary body is a failure. No custom headers (no secrets in config files) and no templating.
- No parameters: every Dynamic Ref is fixed.

### 10.2 Built-in Refs

`#diff` (`git diff`), `#staged` (`git diff --staged`), `#status` (`git status --short`) and `#log` (`git log --oneline -20`). They sit in the lowest layer, so a saved Ref with the same name shadows them. A global `"builtins": false`, or a list of names, turns them off. Outside a git work tree they are hidden from the picker, and a typed one fails with "not a git repository"; it never sends git's error text as output.

### 10.3 Approval

- Built-ins and Global library Refs run without asking.
- A Project library Dynamic Ref runs only after you approve its exact definition (source, argv or URL, and cwd). The choices are: once, always for this definition, or deny.
- "Always" is saved in `~/.pi/agent/pi-context-refs-approvals.json`, keyed by canonical project path, Ref name and a hash of the definition. A changed definition (after a pull, for example) asks again. Approvals are never stored in the project, so a repository cannot approve itself.
- RPC asks through the client's confirm dialog. In print and JSON modes an unapproved Ref does not run: it becomes a failure note, and a hint on stderr says how to approve it. There is no approve-all flag.
- A Bundle never skips an Approval.

### 10.4 Limits and running

By default a 10 s timeout and a 50 KB output cap per Ref; a Ref can raise them up to 120 s and 1 MB. A cut is marked in the Expansion, control characters are stripped, and binary output is a failure. Dynamic Refs run at every send, with no caching across messages. The output is stdout followed by stderr, so a failing test run shows its errors. `pi.exec` reports a command that cannot start as exit 1 with no output, so only that case is checked: a missing working directory or program becomes "cannot start", and any other exit 1 stays a non-zero exit. `pi.exec` buffers all output before the cap applies; the timeout bounds how much a runaway command can write.

### 10.5 What counts as a failure

A non-zero exit is not a failure: the output is used and the exit code appears in the block. The git Built-ins' repository check is the one exception. A real failure is one of: cannot start, timeout, denied, fetch error, binary output, or not approved.

## 11. Recent refs

Decided in [What counts as a Recent ref, and how does it rank against curated refs?](https://github.com/crisboarna/pi-extensions/issues/172), from the evidence in [Which pi session events reveal the files and paths a session has used?](https://github.com/crisboarna/pi-extensions/issues/165).

- **Sources.** A successful `read`, `edit` or `write` call, including nested codemode calls with status `ok` (from `nestedCalls`): the path is resolved the way pi resolves it (strip `@`, expand `~`, convert `file://`, join to the session cwd) and kept only if it lies inside the session cwd. Failed, blocked and invalid calls do not count. Also an `@path` token or a CLI `<file name="…">` path in a sent user message, wherever the file is on disk. Not sources: `ls`, `find` and `grep` directories, `bash` commands, other extensions' and MCP tools, and clipboard or pi temp files.
- **Retention.** Current session only, held in memory; nothing is written. The set is rebuilt from `getBranch()` on `session_start` and `session_tree` (idempotent, not dependent on `reason`) and updated live from tool results and the `input` event. Earlier sessions are never read.
- **Rows.** One row per resolved file, with read and edit merged and a note saying edited or read and how long ago. Ordered by latest use, taken from the stored message timestamp. A bare Trigger shows the 10 newest and a query searches all of them; at most 200 are kept, oldest dropped. The section sits below the curated sections. Hidden: files missing when the picker opens, pi temp files and any path that is the target of a saved Ref.
- **Placeholder.** A Recent ref has no registry entry; its Placeholder carries the path:
  - Path form, inserted on pick: `[ref:<path>]`, cwd-relative inside the project, absolute or `~/…` outside, quoted when the path has spaces. Every such Placeholder contains a `/` (a root file is `[ref:./README.md]`), and saved Ref names never contain `/`, so a path never clashes with a saved name.
  - File form: a key in the `alt+r` overlay switches a row to `[ref:file:<path>]`. It expands to a File block only if the path is inside the session cwd after following symlinks and was used in this session; otherwise it is sent unchanged. A Placeholder pasted from elsewhere therefore cannot read `.env` or a key file that nothing in the session touched. The Path form only prints path text and needs no guard.
  - A typed `#src/api.ts` does not expand in any mode; only the Placeholder does. The picker still claims `#src/…` in the TUI while a Recent row matches.
- **Saving.** `alt+r` saves a Recent row through the add flow, with a File or Path choice. The suggested name is the file name (`api.ts`), with characters outside letters, digits, `.`, `-`, `_` turned into `-`, a trailing `.` dropped, and `-2`, `-3` on a clash in the target library. The user can edit it.

## 12. Failures

Decided in the Dynamic and static-kinds tickets, with the RPC rule settled while assembling.

| Mode | A File or Dynamic Ref fails |
|---|---|
| TUI | The send is cancelled (`input` returns `handled`), the draft comes back through `setEditorText`, and the reason is shown with `ctx.ui.notify`. The notify call is required: pi puts the draft in the editor but repaints it only on the next render, and the notice is what triggers that render (section 16.1). |
| RPC | The Placeholder's block becomes a **Failure note** (`error="…"`, empty body, `bytes="0"`), and the client gets an RPC notification. Approvals still go through the client's confirm. |
| Print, JSON | The same Failure note, and a warning on stderr. |

An unmatched token never fails: it is sent unchanged.

## 13. The transcript

Decided in [How does the transcript show a sent Placeholder, and how is it expanded?](https://github.com/crisboarna/pi-extensions/issues/173) from the findings in [Which pi hooks carry a ref's Expansion to the model while the transcript shows a compact, expandable Placeholder?](https://github.com/crisboarna/pi-extensions/issues/164). ADR [0006](docs/adr/0006-store-the-expansion-in-the-user-message.md).

**Route: an `input` transform plus `registerMarkdownTransformer`.** It is the only simple route that stores the Expansion in the user message. The model gets it in every mode (steer and follow-up included), the prompt cache stays byte-stable, and compaction, export and resume without the extension are right. The routes that keep the transcript clean (hidden or visible side-car, the `context` event, a snapshot entry) each lose steer and follow-up, cost an extra model request, break the cache, or drop content from compaction and export.

**Collapse in the live transcript.**

- Only user messages (the transformer gets `messageType`); assistant text is never touched.
- Only the tail run of Context blocks the extension wrote. Each block is parsed by its declared `bytes` length, so file content that contains a closing tag cannot break the collapse.
- Each block becomes one line (name, kind, size). `[ref:<name>]` stays in the prose. Path and Snippet text replaced inline is not collapsed.

**Seeing the full text.** `/ref sent` shows the full Expansions of the last sent message (read from the session branch) in a read-only dialog, as plain notify text in RPC, and on stderr in print mode (section 14). There is no per-message ctrl+o or click expand: pi gives user messages no expandable state.

**Resend.** A Ref whose `<context-ref name=…>` block is already in the message is not expanded again, so a forked or recalled prompt never doubles content (the same rule as Bundles skipping members already in the draft). Stale content is not refreshed.

## 14. `/ref` commands

Decided in [How are Refs created, edited and removed?](https://github.com/crisboarna/pi-extensions/issues/171), plus `/ref sent` from section 13.

Every command works with full arguments; the TUI dialogs only fill in what is missing, and with no UI and missing arguments a command fails with its usage (the principle of pi-account-guard's `/guard`). Print mode dispatches extension commands, because `session.prompt` runs them, so `pi -p "/ref add …"` works. Its output goes to stderr, never stdout (section 16.1). Subcommands, Ref names, kinds and `in=` values complete through `getArgumentCompletions`.

| Command | Does |
|---|---|
| `/ref`, `/ref list [tag=<tag>] [in=<library>]` | One plain-text block, the same in TUI, RPC and print, through `ctx.ui.notify` in the TUI and in RPC and written to stderr in print mode, where `ctx.ui.notify` prints nothing (section 16.1): settings (`trigger`, `builtins`), Refs by layer (name, kind, tags, target summary), Shadowed Refs, Built-ins, load warnings, and the Approval state of each Project Dynamic Ref (approved or pending). |
| `/ref add <name> <kind> <target…> [desc=<text>] [tags=a,b] [in=<library>] …` | Kind is `path`, `file`, `snippet` or `dynamic`. The rest of the line is the target: a path, the Snippet text, an `http(s)` URL (Dynamic `url`), or an argv for Dynamic `command`, parsed with shell-style quoting and never run through a shell. Other fields (`cwd`, limits, `scope`) are `key=value` or set with `edit`. |
| `/ref edit <name> [key=value …]` | With no `key=value`, the Ref opens as pretty JSON in `ctx.ui.editor`, validated on save (an invalid result reopens with the error); with pairs it changes those fields headless. Renaming is allowed unless it clashes. Covers every field. |
| `/ref remove <name> [in=<library>]` | Removes the Visible Ref. With a UI it confirms first, showing kind, library and target (Snippet text is lost for good) and any Ref it was shadowing; with no UI it runs as typed. `in=` removes a Shadowed Ref from a named library. A Built-in cannot be removed (turn it off with `builtins`). Placeholders already in drafts or history stop resolving and are sent unchanged. |
| `/ref approvals` | This project's Approvals (Ref, definition, date) and any pending Project Dynamic Refs. |
| `/ref approve <name>` | Shows the exact definition and needs a UI confirm. With no UI it refuses and says to run it in pi, so a script cannot approve a hostile repository's Refs. There is no headless or approve-all form. |
| `/ref revoke <name\|all>` | Drops Approvals; needs no confirm. |
| `/ref sent` | The full Expansions of the last sent message (section 13). |

**Which library.** `in=` picks the library. The default is the **Global library, unscoped**, so nothing shared or committed is written by accident. `in=here` writes a Global Ref scoped to this repository (its git remote when there is one, else the directory). `in=project` writes the Project library, in a trusted project only. The TUI wizard asks with Global preselected. `edit` and `remove` work on the library of the Visible Ref of that name (the Global library when none is Visible) unless `in=` names one; `edit <name> in=here` scopes that Global Ref to this repository the same way. `in=here` uses the `origin` remote, else the first remote, normalized to `host/path`.

**Name clashes.** A clash inside the target library (names are case-insensitive) is an error that points to `/ref edit`; nothing is overwritten. The same name in another layer, or a Built-in, is allowed because precedence handles it, and the result line says what the new Ref shadows or is shadowed by.

**Project Dynamic Refs.** Adding or editing one with `in=project` shows the exact definition (argv or URL, and cwd); one confirm saves the Ref **and** records an "always" Approval for exactly that definition hash (TUI, or RPC through the client's confirm). A later change, from you or from a pull, asks again. Headless saves the Ref and records no Approval. Removing the Ref drops its Approval. Approving once in the TUI is the way to prepare print-mode use.

**Picker overlay.** Besides picking: save a Recent row (a key opens the add flow prefilled with the path, a File or Path choice and a suggested name), and edit or remove a saved row with the same editor and confirm as the commands. Built-ins cannot be edited. There is no shortcut that saves the draft as a Snippet.

**Settings.** `trigger` and `builtins` are hand-edited in the Global file; `/ref` shows their values and says a `trigger` change needs `/reload`. There is no `/ref set`.

**Writing the files** (the Global, Project and approvals files):

- Re-read the file just before writing and refuse if it does not parse, naming the file and the error.
- Write atomically (a temporary file, then rename), pretty-printed with a 2-space indent. Hand formatting is normalized on the first write; plain JSON has no comments.
- Keep `version` and `$schema`, and add them when creating a file; keep keys this version does not know.
- Create `<cwd>/.pi/` for the Project library when needed. A Project write needs a trusted project and checks the confinement rule on the Ref before saving it.
- After any write this session reloads its libraries at once; other sessions pick the change up when they next check the files.

## 15. Module structure

Derived while assembling (section 19); the build may adjust it.

Pure core plus thin pi glue, as in pi-account-guard. Pure modules take plain data, with the file reader, command runner, fetch and clock injected, and import nothing from pi.

```text
src/core/                 pure, no pi imports
  names.ts                name rules, case folding, suggested names
  library.ts              parse and validate a library file (JSON path errors), skip bad Refs
  resolve.ts              scope matching, precedence, Visible and Shadowed Refs, Bundles
  tokens.ts               find #name, #tag:<tag> and [ref:…] tokens; boundaries; resend detection
  expand.ts               Expansion building: inline kinds, Context blocks, size cuts, Failure notes
  dynamic.ts              Source running through an injected runner and fetch; limits; failures
  approval.ts             definition hashing and the approvals file shape
  recent.ts               path normalization, ranking, caps
  collapse.ts             tail Context block parser used by the transcript
  ref-command.ts          /ref argument parsing and pure edits
  config-writer.ts        re-read, change, validate, atomic write
src/pi/                   glue
  input.ts                the input handler: modes, status, cancel, failure handling
  editor.ts               the segment merge, the key handling and the feature check
  picker.ts               the autocomplete provider and the alt+r overlay
  transcript.ts           the Markdown transformer
  recent-source.ts        tool and input events feeding Recent refs
  commands.ts             /ref
  git.ts, fs.ts, trust.ts injected readers
src/index.ts              wiring only
schema/pi-context-refs.schema.json
```

Code is erasable TypeScript (no enums, no parameter properties, `.ts` import extensions) so the same files load under jiti in pi and under plain Node in tests. The scaffold's stub command and test are replaced in the first build step.

## 16. Testing

Decided in [What is the testing strategy for the package?](https://github.com/crisboarna/pi-extensions/issues/174).

Runner `node --test` with Node's built-in type stripping, erasable TypeScript, 90% coverage over unit plus integration (`npm run coverage`). Four levels, as in pi-account-guard:

1. **Unit** (`test/unit/**`): the pure core. Token parsing (trigger, whole-word match, trailing `.`, `[ref:file:<path>]`, numeric and unmatched tokens), Ref library loading, precedence, scoping and shadowing, bad-Ref skipping, Bundles, Expansion building and size cuts, Approval hashing, Recent ref ranking, `/ref` argument parsing, and the tail-block collapse parser. Dynamic Refs run through an injected command runner and fetch, so timeout, size cap and failure notes are tested without a process or a socket. Also the repository's usual scans: every source file counted (`all-modules`), core purity, glossary terms, and no real provider or model ids in `src/`.
2. **Integration** (`test/integration/**`):
   - A fake-pi host loading `src/index.ts` through jiti: the `input` handler in each mode, the `/ref` commands, atomic writes, trust gating of the Project library, Approval dialogs.
   - The real pi-tui `Editor` with the package's wrapper, fed key bytes with no terminal: the `#` picker, inserting a Placeholder, atomic delete, undo, paste, an editor swap, and the plain-text fallback.
   - Dynamic Refs against hermetic real things: a child started through `process.execPath` (a metacharacter argument proves no shell; a timeout proves the kill; output past 50 KB proves the cap), a `127.0.0.1` `http.createServer` for URL sources, and real `git` in temporary repositories for the Built-in Refs, including hidden outside a repository. No user command and no external network ever runs.
   - A contract test that asserts the private `segment` shape of the installed pi-tui on every run, so a pi upgrade turns CI red instead of silently degrading the Placeholder to plain text.
3. **Smoke** (`test/smoke/**`, `npm run test:smoke --workspace packages/pi-context-refs`): real pi with `-ne -e`, `PI_OFFLINE`, no credentials and a stub provider that echoes what it received, so the test asserts the model's text. Run in CI as a step beside the account-guard one with `PI_BIN` set to the pinned pi; not part of `npm test`. Covers print mode (a typed ref expands for every kind, a Failure note), RPC (a failed Dynamic Ref becomes a Failure note with a notification, steer and follow-up, an Approval answered only through `extension_ui_response`, never headless) and a few pty flows through `tools/media/run-in-pty.py`: `#` opens the list, a pick inserts a Placeholder, a send collapses the tail blocks while the model got the full text, and a failed Ref restores the draft.
4. **Assumptions first.** `test/smoke/assumptions.test.ts` and the tests listed in section 16.1 were build step 1: one test per pi behaviour the design relies on. A failing item amended this design before more code existed.

### 16.1 Assumed pi behaviour

Every row was proved against pi 1.4.0 before any feature code was written, by the test named in the last column (all under `packages/pi-context-refs/test/`). Smoke tests run real pi and are opt-in (`npm run test:smoke --workspace packages/pi-context-refs`); integration tests run in `npm run test:integration`.

| Assumption | Result | Proved by |
|---|---|---|
| An `input` rewrite reaches the model, including steer and follow-up | Holds. In RPC the `input` event also fires for a steer and a follow-up, with `streamingBehavior` `steer` or `followUp`. Images returned by the handler reach the model | `smoke/assumptions.test.ts` |
| `registerMarkdownTransformer` collapses the tail Context blocks of a user message, and receives `messageType` | Holds: `user`, `assistant` and `assistant-thinking`. The live transcript shows the rewritten text; the model got the full text | `smoke/assumptions-tui.test.ts` (pty) |
| `input` returning `handled` plus `ctx.ui.setEditorText` restores the draft | **Holds only with a repaint.** In the TUI the editor state is restored, but pi does not repaint until the next render, so an empty editor stays on screen. A `ctx.ui.notify` after it (the failure notice of section 12) triggers the repaint. In RPC the client gets a `set_editor_text` request | `smoke/assumptions-tui.test.ts` (pty); RPC from pi-account-guard's suite |
| `ctx.ui.confirm` is `false` with no UI and reaches the client in RPC | Holds. `ctx.hasUI` is `false` in print mode; in RPC the client answers with `extension_ui_response` (`confirmed`) | `smoke/assumptions.test.ts` |
| `#` autocomplete chains through `addAutocompleteProvider`, and unmatched or numeric tokens fall through | Holds with pi's own chain: the last provider registered is asked first, and a provider that returns the next one's suggestions hands a token on. `# heading` opens nothing | `integration/autocomplete-chain.test.ts` (real pi-tui `Editor`) |
| A typed token of `/` characters (`#src/…`) keeps the picker open while a Recent row matches | Holds: with the list open, every key re-asks the provider, so the list stays while a row matches and closes when none does | `integration/autocomplete-chain.test.ts` |
| pi-tui's `Editor.prototype.segment` exists and keeps pi's paste markers atomic when merged | Holds in both `grapheme` and `word` mode. Backspace, the cursor, Ctrl+W and undo treat a merged `[ref:…]` as one unit, and `[paste #N]` stays atomic beside it. Ctrl+W deletes only the Placeholder because the merged segment is not word-like | `integration/editor-segment-contract.test.ts` (runs on every build) |
| Extension commands run in print mode | Holds, with no turn sent to the model. **Output does not:** `ctx.ui.notify` prints nothing in print mode, and `process.stdout.write` from an extension is redirected to stderr, so a command's output in print mode goes to stderr (section 14). In RPC, notify arrives as an `extension_ui_request` | `smoke/assumptions.test.ts` |
| `ctx.isProjectTrusted()` reflects `/trust` | **Differs.** It reflects the decision pi resolved at start: `--approve` or `--no-approve`, then a saved decision for the directory or the nearest parent, then `defaultProjectTrust`. `/trust` saves a decision for the next start and leaves the running session as it was. A project with no trust-requiring resource is trusted without any decision, so a library-only `.pi/pi-context-refs.json` loads (section 5.2) | `integration/project-trust.test.ts` (real pi, print and pty) |
| Tool results carry the path as sent, and `nestedCalls` carry codemode's inner calls | Holds. The path is as the model wrote it (`@note.txt` keeps its `@`), so the Recent ref resolver strips and resolves it. A codemode result carries `nestedCalls.calls` (`id`, `name`, `arguments.path`, `status` `ok` or `error`); each inner call also raises a `tool_result` event with `parentToolCallId`. `nestedCalls` is on the stored tool result message, not on the `tool_result` event | `integration/tool-results.test.ts` (real pi) |

The test doubles are in `test/support/`: a stub provider that answers locally and echoes the last user message it received, a probe extension (one scenario per run, not package code), a pty runner that reads the screen through xterm.js, and a real pi-tui `Editor` driven by key bytes.

### 16.2 Manual checklist

Run in a real TUI.

- The look of the inline list and the `alt+r` overlay at narrow widths, in themes and with wide characters.
- Fork, resume, export and compaction showing the full text.
- `ctrl+o` expansion.
- Ctrl+W and undo by keystroke, and Up-arrow recall (not tried with the prototype).
- Coexistence with pi-image-view, pi-up-history, pi-cc-steer, pi-multi-pass and pi-powerline-footer (not tried with the prototype).
- The Approval prompt wording.

## 17. Known limits

- A path used only through `bash` or `ls` never becomes a Recent ref. Paths outside the project from tool calls never appear. `@` completions need the sent text to be seen.
- With the `input` route the stored message holds the full Expansion. The fork selector and the editor after a fork, up-arrow after resume, the steering queue line, HTML export and the compaction summary show or see the full text. Each extension gets one Markdown transformer.
- A Context block whose content contains `</context-ref>` is not escaped (section 9.2). The collapse is safe because of `bytes`; the model still sees the raw text.
- Pi gives user messages no expandable state, so there is no per-message ctrl+o or click expand (`/ref sent` instead).
- Images are attached unresized.
- A Placeholder relies on one TS-private pi-tui method (ADR 0001). A pi upgrade can degrade it to plain text; the contract test catches that in CI, and the fallback still expands on send.
- Stale content is never refreshed: a block already in a resent message stays as it was.
- Snippets cannot contain Refs.
- A `#` in the middle of prose that happens to match a Ref name (`#api`) expands. The match is exact and whole-word, but a Ref named `todo` makes every `#todo` expand.

## 18. Not yet specified

Still fog on the map, and out of scope for v1:

- A budget across every Ref in one message: estimating the Expansion's size and warning before send. Only per-Ref caps exist (sections 9.4, 10.4).
- Whether a Ref can appear inside a prompt template, or be offered by a skill.
- Recording which version of a Ref was sent, for audit, replay and resume.
- How other extensions that read the user message (the pi-switchboard classifier, pi-account-guard) see an Expansion.

## 19. Decision index

| Decision | Ticket | ADR |
|---|---|---|
| Editor marker prior art | [How do existing pi packages draw atomic markers and chips in the editor?](https://github.com/crisboarna/pi-extensions/issues/163) | |
| Hooks that carry the Expansion | [Which pi hooks carry a ref's Expansion to the model…](https://github.com/crisboarna/pi-extensions/issues/164) | |
| Session paths | [Which pi session events reveal the files and paths a session has used?](https://github.com/crisboarna/pi-extensions/issues/165) | |
| Names and trigger | [What is the package called, and what are its trigger key, command and config names?](https://github.com/crisboarna/pi-extensions/issues/166) | |
| Refs and libraries | [What is a Ref, and where does the Ref library live?](https://github.com/crisboarna/pi-extensions/issues/167) | [0002](docs/adr/0002-scoped-over-project-over-global.md), [0003](docs/adr/0003-project-library-follows-trust-and-is-confined.md) |
| Picker and Placeholder | [How do the picker and the Placeholder look and behave in the editor?](https://github.com/crisboarna/pi-extensions/issues/168) | [0001](docs/adr/0001-atomic-text-placeholder-over-private-segment.md) |
| Static kinds | [What does each static ref kind (Path, File, Snippet) expand to, and when is its content read?](https://github.com/crisboarna/pi-extensions/issues/169) | [0005](docs/adr/0005-inline-text-kinds-and-framed-blocks.md) |
| Dynamic refs | [How do Dynamic refs run, and what stops one doing harm?](https://github.com/crisboarna/pi-extensions/issues/170) | [0004](docs/adr/0004-approve-project-dynamic-refs-by-definition-hash.md) |
| Managing Refs | [How are Refs created, edited and removed?](https://github.com/crisboarna/pi-extensions/issues/171) | |
| Recent refs | [What counts as a Recent ref, and how does it rank against curated refs?](https://github.com/crisboarna/pi-extensions/issues/172) | |
| Transcript | [How does the transcript show a sent Placeholder, and how is it expanded?](https://github.com/crisboarna/pi-extensions/issues/173) | [0006](docs/adr/0006-store-the-expansion-in-the-user-message.md) |
| Testing | [What is the testing strategy for the package?](https://github.com/crisboarna/pi-extensions/issues/174) | |

Settled while assembling, where closed tickets disagreed (confirmed with the user):

- **Bracket boundary.** The static-kinds ticket ends a `[ref:<name>]` at the first non-name character, but the Recent refs ticket puts `/` and `:` inside it. Only `]` ends a bracketed Placeholder; the name-character rule is for typed `#name` tokens.
- **`bytes` on the Context block.** The transcript ticket parses blocks by a declared length that the static-kinds frame did not list. The frame gains `bytes`.
- **RPC failures.** The static-kinds and Dynamic tickets give RPC a Failure note; the testing ticket had the draft restored. RPC gets the Failure note; only the TUI restores the draft.

Settled while building the picker (flag if wrong): a Built-in Ref's row carries the mark ○ and the word "built-in", and sits between the global rows and the Bundles; the Trigger moves only the picker, so a typed `#name` expands whatever the setting says; the picker re-reads both libraries on every key it is asked about, and asks git whether the directory is a work tree when the list opens.

Derived in this document (not asked, flag if wrong): the module structure (section 15); the exact fields `timeout` and `max_output` and `max_bytes` for per-Ref limits; the `pi-context-refs.schema.json` path; the table of assumptions in section 16.1; the `/ref sent` row in the command table; Built-in Refs ranked below unscoped Global Refs in the precedence line of section 5.4.

## 20. Sources

- pi docs (`extensions.md`, `docs/security.md`, `docs/configuration.md`, `docs/rpc-extension-ui.md`) and pi-tui's `editor.js` in the pi 1.4.0 install.
- pi-account-guard `DESIGN.md` (§3, §11, §17) and pi-switchboard `DESIGN.md` §7 for the shared conventions.
- Research notes on throwaway branches: `research/context-refs/editor-markers`, `research/context-refs/expansion-hooks`, `research/context-refs/recent-paths`; the editor prototype on `prototype/pi-context-refs/editor`.
