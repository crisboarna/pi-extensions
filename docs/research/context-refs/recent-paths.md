# Research: which pi session events reveal the files and paths a session has used?

Ticket: [#165](https://github.com/crisboarna/pi-extensions/issues/165), on the map [#162](https://github.com/crisboarna/pi-extensions/issues/162). It gathers the raw material for Recent refs. Ranking and retention are left to [#172](https://github.com/crisboarna/pi-extensions/issues/172).

**Scope.** pi 1.4.0 as installed in this repository (`node_modules/@earendil-works/`). Citations use these prefixes:

- `pca/` is `node_modules/@earendil-works/pi-coding-agent/`
- `tui/` is `node_modules/@earendil-works/pi-tui/dist/`
- `core/` is `node_modules/@earendil-works/pi-agent-core/dist/`
- `ai/` is `node_modules/@earendil-works/pi-ai/dist/`
- `psr/` is the published `pi-session-resources@0.8.0` tarball (<https://unpkg.com/pi-session-resources@0.8.0/>), read but never run

"Probe" means the offline real-pi runs described in [Probe](#probe). In probe output, `<project>`, `<agentDir>` and `<tmpdir>` stand for temporary directories.

## Answer

- **Tool calls are the main source.** `read`, `edit` and `write` take one `path`. `ls`, `find` and `grep` take an optional directory `path`. The path shows up in `tool_execution_start.args`, `tool_call.input` and `tool_result.input`. It is the string the model wrote, so it can be relative to `ctx.cwd`, absolute, `~/…`, `@…` or `file://…`. Pi resolves it inside the tool and never reports the resolved absolute path. Built-in `details` add no resolved path either: the `edit` patch header repeats the input path, and the `bash` `fullOutputPath` is pi's own temp file.
- **`bash` has no path field.** It carries only a `command` string, and the command can `cd` part-way through. Recovering paths from it is a heuristic. The only path pi itself puts in a bash result is its own temp file (`details.fullOutputPath`).
- **Use `tool_execution_start` and `tool_execution_end` to see every call.** `tool_call` is skipped for calls that fail validation, and for calls an earlier extension blocks. `tool_result` fires only for calls that actually ran. Calls made through `ctx.executeTool()` (codemode, nested tools) fire the same events with `parentToolCallId` set.
- **Tools from other extensions and MCP servers have free-form arguments.** They arrive as `input: Record<string, unknown>`, and `pi.getAllTools()` gives each tool's schema. MCP paths are relative to the MCP server, which pi does not know.
- **No event fires when an `@` completion is accepted.** The only way to see it is to wrap the provider passed to `ctx.ui.addAutocompleteProvider`. The wrapper then sees `applyCompletion(item, prefix)` with `item.value` such as `@src/a.txt` or `@"docs/with space.md"`. This works in the TUI only, and only when `fd` is available. After that, the path is plain text in `input.text` and in the stored user message.
- **CLI `@file` and pasted files leave only text.** For CLI `@file`, the `input` text (source `"interactive"`, also in print mode) contains `<file name="/absolute/path">…</file>`; RPC rejects `@file`. Ctrl+V of an image writes `<tmpdir>/pi-clipboard-<uuid>.<ext>` and inserts that absolute path as editor text. Copied or dragged files insert their paths as text. Image attachments (`input.images`, RPC `images`) are base64 with no path.
- **Pi already tracks files.** Compaction and branch summaries store `details: { readFiles, modifiedFiles }`. These are built from `read`/`write`/`edit` arguments as the model wrote them, unresolved, and include nested calls.
- **On resume, nothing is lost.** `ctx.sessionManager.getBranch()` returns every entry on the active path, including entries that compaction summarized. That covers assistant `toolCall` blocks with their raw `arguments`, `toolResult` messages (`toolCallId`, `toolName`, `isError`, `nestedCalls`), user text, `bashExecution` commands and compaction details. The session header gives the absolute `cwd`.
- **Earlier sessions of the same project can be read through public exports.** Call `SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir())` to list them, then read each file and parse it with `parseSessionEntries`. This never touches `auth.json`. But session files hold whole transcripts: file contents, command output, and other extensions' tool `details` and custom entries. A reader should pick out only the path fields.
- **Prior art: pi-session-resources** collects paths from successful `tool_result` events. It rebuilds from `getBranch()` on `session_start` and `session_tree`, scans path-like keys in every tool's input, content and details, and takes only absolute and `~/` paths from bash. It keeps nothing across sessions and ignores user text.

## Built-in tools

### Event order and which calls each event sees

Pi documents the order as `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end` (`pca/docs/extensions.md:103-109`). The agent loop sets the rules:

- `tool_execution_start` fires for every call before preparation. Its `args` are the raw model arguments (`core/agent-loop.js:384-390`, `:420-426`).
- `tool_call` fires only after the tool is found, `prepareArguments` has run and validation has passed (`core/agent-loop.js:487-505`). Its `input` is a `structuredClone` of the arguments (`ai/utils/validation.js:284`), and handlers may mutate it (`pca/dist/core/extensions/types.d.ts:978-984`). The runner stops at the first handler that blocks, so extensions loaded later never see a blocked call (`pca/dist/core/extensions/runner.js:957-972`).
- An unknown, invalid or blocked call becomes an "immediate" error result. It gets `tool_execution_end` with `isError: true`, but no `tool_result` (`core/agent-loop.js:489-523`, `:392-398`).
- `tool_result` fires after `execute()`, including when it throws. Its `input` is the same prepared arguments object (`pca/dist/core/agent-session.js:348-363`). Handlers chain, so an earlier handler can change `isError` (`pca/dist/core/extensions/runner.js:900-956`).
- With parallel execution, `tool_result` events arrive in completion order, not call order (probe A).

Probe A confirmed this. `read` with `{}` produced only `tool_execution_start` and `tool_execution_end` (`isError: true`). A legacy `edit` call `{path, oldText, newText}` reached `tool_execution_start` raw and `tool_call` normalized to `{path, edits: [...]}`. That normalization is `prepareEditArguments` (`pca/dist/core/tools/edit.js:91`).

### Payload fields per tool

Only `read`, `bash`, `edit` and `write` are active by default. `ls`, `find` and `grep` exist but must be enabled (`pca/dist/core/agent-session.js:2989-2991`, `pca/dist/core/settings-manager.js:35`, `pca/docs/cli.md:128`).

| Tool | Input fields with paths | `details` | Paths in result `content` |
|---|---|---|---|
| `read` | `path` (+ `offset`, `limit`) (`pca/dist/core/tools/read.d.ts:6-10`) | `truncation` only (`read.d.ts:29-31`) | none, except error text such as `ENOENT … access '<project>/missing.txt'` (probe A) |
| `edit` | `path`, `edits[]` (`edit.d.ts:5-11`) | `diff`, `patch`, `firstChangedLine` (`edit.d.ts:17-23`); the `patch` header repeats the input path as written (probe A) | `Successfully replaced 1 block(s) in src/a.txt.` |
| `write` | `path`, `content` (`write.d.ts:4-7`) | always `undefined` (`pca/dist/core/extensions/types.d.ts:1018-1021`) | `Successfully wrote to out/new.txt` |
| `ls` | optional `path`, default `.` (`ls.d.ts:5-8`) | `truncation`, `entryLimitReached` (`ls.d.ts:14-16`) | entry names relative to the listed directory |
| `find` | `pattern`, optional `path` (`find.d.ts:8-12`) | `truncation`, `resultLimitReached` | matches relative to the search directory (`find.js:11-16`, `:94`) |
| `grep` | `pattern`, optional `path` (directory or file), `glob` (`grep.d.ts:5-13`) | `truncation`, `matchLimitReached`, `linesTruncated` | match lines prefixed with a path relative to the search directory, or the basename when `path` is a file (`grep.js:69-77`) |
| `bash` | `command`, `timeout` (`bash.d.ts:6-9`) | `truncation`, `fullOutputPath` (`bash.d.ts:27-29`) | output; when truncated, `Full output: <tmpdir>/pi-bash-….log` (`bash.js:238-249`) |

In every path-taking tool, `execute()` resolves `path` against `ctx?.cwd || cwd`. See `read.js:73`, `edit.js:94`, `write.js:31`, `ls.js:40`, `find.js:65` and `grep.js:57`, all in `pca/dist/core/tools/`. The resolved path stays inside the tool.

`find` and `grep` need `fd` and `rg`. Offline and without them, the calls fail with `fd is not available and could not be downloaded` (probe A). Their input still reaches every event.

### Absolute or relative

The path is whatever string the model sent. Pi's resolution (`pca/dist/core/tools/path-utils.js:35-44`, `pca/dist/utils/paths.js:59-87`) does this:

- strips a leading `@` (so `@docs/with space.md` works, probe A)
- turns Unicode spaces into plain spaces
- expands `~` and `~/`
- converts `file://` URLs
- resolves a relative path against the session cwd

`read` also tries macOS screenshot variants: a narrow no-break space before AM/PM, NFD, and curly apostrophes (`path-utils.js:45-71`). The string in the event can therefore differ from the file name on disk. `resolveToCwd` and `resolveReadPath` are not exported from the package (`pca/dist/index.d.ts:9`), so a consumer must reimplement them.

### Recovering paths from `bash`

- The model's `bash` call carries only `command` (probe A: `cat src/a.txt && cd docs && ls`). The command runs in the session cwd. A `cd`, globbing, variables and heredocs inside it change what the paths mean.
- A heuristic can tokenize the command and keep tokens that exist on disk. Commands with a `cd` cannot be resolved reliably. pi-session-resources takes only absolute and `~/` paths from bash (`psr/src/collector.ts:108`, `:476-497`, `:533`).
- The only path pi adds to a bash result is its own temp file. It is created by `createOutputFileStream("pi-bash", ".log")` under `os.tmpdir()` with mode 0600 (`pca/dist/core/bash-executor.js:30`, `pca/dist/utils/output-files.js:13-17`).
- `!cmd` and `!!cmd` typed by the user, and the RPC `bash` command, fire `user_bash` with `command`, `excludeFromContext` and an absolute `cwd` (`pca/dist/core/extensions/types.d.ts:898-906`, `pca/dist/modes/rpc/rpc-mode.js:439-457`; probe C and D). They are stored as `bashExecution` messages with `command` and `output`, but no `cwd` (`pca/dist/core/messages.d.ts:16-27`, `pca/dist/core/agent-session.js:3184`).

## Editor input: `@` completions, typed paths, clipboard and drag

- **No event.** The editor applies a completion by calling `applyCompletion` on the outermost provider (`tui/components/editor.js:613-631`, `:1883`, `:1989`). Pi builds the chain by passing each `addAutocompleteProvider` factory the current provider (`pca/dist/modes/interactive/interactive-mode.js:545-560`, `:2077-2080`; `pca/dist/core/extensions/types.d.ts:66`).
- **A wrapper sees every accepted completion,** as long as no later wrapper swallows it without delegating. In probe D it logged `{prefix: "@with", value: "@\"docs/with space.md\"", label: "with space.md", description: "docs/with space.md"}` and `{prefix: "@src/a", value: "@src/a.txt"}`. It also saw `/quit`. Tab path completion without `@` reaches the same method.
- **Values are relative to the session cwd.** The base provider is created with `this.sessionManager.getCwd()` (`interactive-mode.js:543`). A value keeps `~/` or a leading `/` when the user typed one. Paths with spaces are quoted (`tui/autocomplete.js:110-119`, `:290-328`).
- **`@` suggestions need `fd`.** `getFuzzyFileSuggestions` returns nothing without it (`tui/autocomplete.js:610-613`). The TUI downloads `fd` and `rg` to `<agentDir>/bin` at startup (`interactive-mode.js:774-781`, `pca/dist/utils/tools-manager.js:76-92`). Offline with no `fd`, typing `@docs/w` showed no list; with an `fd` shim it did (probe D).
- **The sent text keeps the tokens.** `input.text`, `before_agent_start.prompt` and the stored user message all carry `check @"docs/with space.md" and @src/a.txt` (probe D). Pi does not inline `@path` in the TUI. The model reads the file with `read`, which strips the `@`.
- **The completion wrapper is TUI-only.** In RPC mode `addAutocompleteProvider` is a no-op (charting).
- **Clipboard (Ctrl+V).** Copied files insert their original paths, joined by newlines. Images are written to `<tmpdir>/pi-clipboard-<uuid>.<ext>`, and that absolute path is inserted as text. Otherwise the clipboard text is inserted (`interactive-mode.js:2458-2496`). No event fires, and pi never deletes the temp image. Dragging a file into a terminal inserts its path (`pca/docs/usage.md:14-18`).
- **Image attachments carry no path.** `input.images` and RPC `prompt.images` are `ImageContent` with base64 data (`pca/dist/core/extensions/types.d.ts:910-920`, `rpc-mode.js:298-311`). The stored user message keeps the base64 (probe C).

## CLI `@file` arguments

- `pi @a @b msg` collects the `@` arguments (`pca/dist/cli/args.js:26-27`, `:238-239`). It resolves each one against `process.cwd()`, including `~` and the macOS screenshot variants (`pca/dist/cli/file-processor.js:18`).
- Text files become `<file name="ABS">\n…\n</file>\n`. Images become attachments, with `<file name="ABS"></file>` or a hints line (`file-processor.js:33-66`). The result is prepended to the first message (`pca/dist/cli/initial-message.js:5-20`, `pca/dist/main.js:171-182`).
- The initial prompt goes through `session.prompt()` without a `source` (`interactive-mode.js:894-896`, `pca/dist/modes/print-mode.js:104-105`). So `input` fires with `source: "interactive"` even in print mode (`agent-session.js:1652`; probe A).
- No event or API exposes the parsed list. A consumer has to parse `<file name="…">` out of `input.text` or the stored user message. RPC mode exits with an error instead (`main.js:526-527`, `pca/docs/cli.md:51`).

## Other extensions' tools, MCP and codemode

- **Custom tools.** `CustomToolCallEvent` and `CustomToolResultEvent` carry `toolName: string`, `input: Record<string, unknown>` and `details: unknown` (`pca/dist/core/extensions/types.d.ts:974-977`, `:1034-1037`). `pi.getAllTools()` returns each tool's `parameters` schema, `annotations` (`readOnlyHint`, …) and `sourceInfo` (`types.d.ts:1284`, `:1577-1582`, `:400-409`). Recognizing a path argument therefore means guessing from key names or schema descriptions. A probe tool `probe_open {file}` reached every event (probe A).
- **MCP.** Tools are named `mcp__<server>__<tool>` (`pca/docs/mcp.md:77`). `read_mcp_resource` takes `{server, uri}`, and binary resources are saved to temp files whose path goes to the model (`mcp.md:240-242`). A path argument of an MCP filesystem server is relative to that server, not to pi's cwd.
- **Codemode and nested calls.** Calls made through `ctx.executeTool()` get the id `<parent>/<n>` and fire `tool_execution_*`, `tool_call` and `tool_result` with `parentToolCallId`. They never appear as transcript tool calls. The parent's `toolResult` message keeps a bounded `nestedCalls` record of `{id, name, arguments, status, durationMs}` (`pca/docs/extensions.md:261`; `ai/types.d.ts:401-419`). Arguments over 8 KiB per call or 32 KiB per result are omitted, at most 256 calls are kept, and `complete: false` marks a lossy record (`pca/dist/core/nested-tool-calls.d.ts:17-22`). Probe A's `probe_nested` showed `t14/1` with `parentToolCallId: "t14"`, and stored `nestedCalls: {calls: [{id: "t14/1", name: "read", status: "ok", arguments: {path: "docs/b.md"}}], complete: true}`.

## Pi's own file tracking

- Compaction and branch summarization collect `read`, `write` and `edit` paths. Sources are the assistant `toolCall` blocks and the `nestedCalls` on tool results. They use `args.path` exactly as written (`pca/dist/core/compaction/utils.js:16-52`).
- The lists are sorted. A file that was both read and modified is listed as modified only (`utils.js:57-62`).
- The lists are appended to the summary text as `<read-files>` and `<modified-files>` (`utils.js:66-77`). They are stored as `details: { readFiles, modifiedFiles }` on the `compaction` entry (`pca/dist/core/compaction/compaction.js:713-723`) and on the `branch_summary` entry (`branch-summarization.js:241-247`). They carry forward from the previous pi-generated compaction (`compaction.js:16-39`).
- `session_before_compact.preparation.fileOps` exposes the same sets (`read`, `written`, `edited`) before summarizing (`pca/dist/core/compaction/compaction.d.ts:118-134`).
- Probe C: `readFiles = ["<project>/docs/b.md", "@docs/with space.md", "missing.txt"]` and `modifiedFiles = ["docs/b.md", "out/new.txt", "src/a.txt"]`. The lists mix forms, and failed reads count too.
- `ls`, `find`, `grep`, `bash` and other tools are not tracked. Entries with `fromHook: true` come from an extension, and their `details` shape is that extension's own (`pca/docs/session-format.md:133-137`).

## The current session on resume, fork and tree navigation

- `session_start.reason` is `startup`, `reload`, `new`, `resume` or `fork`, with `previousSessionFile` for the last three (`pca/dist/core/extensions/types.d.ts:575-581`). `pi --continue` and `--session` start with reason `"startup"`, not `"resume"` (probe B; default at `agent-session.js:199`). `/resume` and RPC `switch_session` give `"resume"` (`pca/dist/core/agent-session-runtime.js:141`, `:291`).
- `ctx.sessionManager` is read-only. It offers `getBranch`, `getEntries`, `getHeader`, `getCwd`, `getSessionDir`, `getSessionFile` and `getTree` (`pca/dist/core/session-manager.d.ts:178`).
- `getBranch()` walks from the leaf to the root and includes every entry type (`session-manager.d.ts:306-311`). Probe E resumed a compacted session: `getBranch()` still held every pre-compaction `toolCall`, followed by the `compaction` entry. `buildContextEntries()` drops summarized entries, so it is the wrong source.
- Pi's own guidance is to rebuild branch-sensitive state from `getBranch()` in `session_start`, not from every file entry (`pca/docs/extensions.md:343-349`). After `/tree`, `session_tree` gives `newLeafId`, `oldLeafId` and an optional `summaryEntry` (`types.d.ts:664-670`).
- Stored entries keep what the model sent. `toolCall.arguments` are the raw arguments: probe B showed the legacy `edit` shape and `read {}` as stored. The `toolResult` message has `toolCallId`, `toolName`, `isError`, `details` and `nestedCalls`, but not the input (`ai/types.d.ts:420-435`). Join the two by id, as pi-session-resources does (`psr/src/collector.ts:665-696`).
- The base for relative paths is the header `cwd` (`session-manager.d.ts:5-12`). The first system message also records it as `sections.cwd = "<cwd>\n…\n</cwd>"` (probe B; `pca/docs/session-format.md:80-87`).

## Earlier sessions of the same project

### Location and format

- **Location.** Sessions live in `<agentDir>/sessions/--<cwd with the leading separator removed and / \ : replaced by ->--/<timestamp>_<session-id>.jsonl` (`pca/docs/session-format.md:8-14`, `pca/dist/core/session-manager.js:290-295`). `<agentDir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent` (`pca/dist/config.js:491-497`).
- **Overrides.** `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting change the location (`pca/docs/sessions.md:48-54`). Sessions then sit in one flat directory for every project. `--no-session` keeps the session in memory only (`pca/dist/main.js:286-287`).
- **When the file appears.** Pi creates it only once the session has a user or assistant message (`session-manager.d.ts:248-253`).
- **Format.** JSONL: a header line `{type: "session", version: 3, id, timestamp, cwd, parentSession?}`, then tree entries such as `message`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label` and `session_info` (`pca/docs/session-format.md:62-207`).

### Reading them through the public API

- `SessionManager`, `parseSessionEntries`, `migrateSessionEntries` and `buildSessionContext` are package exports (`pca/dist/index.d.ts:21`).
- `SessionManager.list(cwd, sessionDir, onProgress, signal)` returns `SessionInfo` for each file: `path`, `id`, `cwd`, `name`, `parentSessionPath`, `created`, `modified`, `messageCount`, `firstMessage` and `allMessagesText` (`session-manager.d.ts:163-177`). With a custom directory, it filters to sessions whose header `cwd` matches (`session-manager.js:1449-1459`).
- Probe C and E listed earlier sessions with `SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir())`. Each file was read with `readFileSync` and parsed with `parseSessionEntries`. The header came first, followed by every stored `toolCall` and user message.
- Avoid these calls:
  - `SessionManager.list(cwd)` without `sessionDir`. It calls `getDefaultSessionDir`, which creates the directory (`session-manager.js:296-302`), and it ignores a custom `sessionDir`.
  - `SessionManager.open(path)` on another file. It rewrites the file when it migrates an older version (`session-manager.js:721-724`), and it initializes an empty file (`:670-680`). Use `parseSessionEntries` plus `migrateSessionEntries` in memory instead.
  - `SessionManager.listAll()`. It scans every project's sessions (`session-manager.js:1460-1474`).
- `list()` reads every file in full to build `allMessagesText` (`session-manager.js:492-566`). A large history makes it slow; pass `signal` and keep it off the startup path.

### What reading touches

- No credentials. `auth.json` and `models-store.json` sit in `<agentDir>` itself, next to `sessions/` (probe: listing of `<agentDir>`). A reader that stays inside `getSessionDir()` never opens them.
- Session files are whole transcripts. Pi warns that they hold "prompts, model responses, tool arguments, command output, file contents, and extension messages" (`pca/docs/sessions.md:60`). They also hold the full system prompt and base64 images.
- Other extensions keep their private state in the same files. Pi's state guidance puts it in tool-result `details`, `custom` entries and `custom_message` details (`pca/docs/extensions.md:337-346`). A Recent-ref reader that wants to stay off other extensions' state should read only:
  - the header `cwd`
  - `toolCall` `name` and `arguments`
  - `toolResult` `toolCallId`, `toolName`, `isError` and `nestedCalls`
  - user text (for `@` tokens and `<file name>`)
  - `bashExecution.command`
  - `readFiles` and `modifiedFiles` of pi-generated compaction and branch-summary entries

  It should skip `content`, non-built-in `details`, `custom` and `custom_message` entries.

## Prior art: pi-session-resources 0.8.0

Read from the published tarball (`npm pack pi-session-resources@0.8.0`). Its README says: "It collects files, web pages, and PR/MR links from successful tool activity, then opens a tabbed resource picker above the editor when you type `#`" (`psr/README.md`).

- **Live collection.** A `tool_result` handler skips `isError` results (`psr/src/index.ts:87-99`). For built-in `read`, `write`, `edit`, `grep`, `find` and `ls` it records `input.path` with the action read, changed or inspected (`collector.ts:165-172`, `:535-547`).
- **Scanning.** It walks `input`, `content` and `details` of every tool, up to depth 8 and 100,000 characters. It records values under path-like keys (`path`, `file`, `filepath`, `directory`, `targetfile` and others) and URL keys. Custom tools get an action guessed from the tool name (`collector.ts:99-163`, `:309-317`, `:402-515`). Loose regex matching of absolute and `~/` paths applies to bash input only (`collector.ts:532-533`).
- **Normalization.** It strips `@`, quotes and `#L12` or `:12:3` suffixes, expands `~`, resolves relative paths against `ctx.cwd` and calls `realpath` on files that exist. Input paths may be missing; output paths must exist (`collector.ts:174-235`, `:366-383`). Labels are cwd-relative inside the project and absolute outside it, with control characters stripped (`collector.ts:187-190`, `:237-244`).
- **Rebuild.** On `session_start` and `session_tree` it calls `collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd)`. That joins assistant `toolCall` blocks with successful `toolResult` messages (`index.ts:68-85`, `collector.ts:665-696`). It does not read `nestedCalls`, so codemode paths are lost on rebuild even though the live `tool_result` saw them.
- **Gaps.** It has no persistence and no earlier sessions, and it reads no user text, CLI `@file` or `user_bash`. It resolves every stored entry against the current `ctx.cwd`. It reads other extensions' tool `details`.
- **Insertion.** The picker wraps the previous editor factory through `setEditorComponent` (`index.ts:50-65`). It inserts `#path`, or `#"path with spaces"`, as plain text: "A reference is ordinary prompt text: it does not read a file again or add hidden model context" (`psr/README.md`, `autocomplete.ts:100-106`).

## Probe

These runs used the repository's pinned pi 1.4.0 (`node_modules/.bin/pi`). Each run had a fresh `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, credential-like environment variables removed, and `-ne`. The scaffolding was adapted from `packages/pi-account-guard/test/support/stub-provider.ts` and `pi-process.ts`, and the throwaway files stayed in the session scratch space:

- **Stub provider.** It answers the first request after a "please work" prompt with 14 tool calls, then answers text. The calls: `read` of a relative, an absolute, an `@`-prefixed and a missing path; `read {}`; `edit` in the current and the legacy shape; `write`; `bash` with a `cd`; `ls`; `find`; `grep`; a custom tool `probe_open {file}`; and a tool that calls `read` through `ctx.executeTool`.
- **Logging extension.** It writes the payload of `session_start` to JSONL, along with `getBranch()`, the earlier-session listing, `input`, `before_agent_start`, `user_bash`, all `tool_*` events, `message_end` and an autocomplete wrapper.

The runs:

- **A.** `pi -p @docs/b.md "please work"`, with the session saved.
- **B.** `pi --continue -p again`.
- **C.** `--mode rpc`: `bash`, a prompt, a prompt with an image, `compact` (with `keepRecentTokens: 1`), then `switch_session` back to A.
- **D.** The TUI in tmux. Two `@` completions were accepted, the message was sent, then `!ls docs` and `/quit`. An `fd` shim sat in `<agentDir>/bin` because `fd` is not installed.
- **E.** `pi --session <C's id> -p again` on the compacted session.

Every claim marked "probe" above came from these logs. Two results were not in the docs:

- RPC `switch_session` emitted `session_start` (`resume`) twice for one switch. `runtimeHost.switchSession` already calls the rebind hook, and the command handler calls `rebindSession()` again (`pca/dist/modes/rpc/rpc-mode.js:225-227`, `:474-478`, `pca/dist/core/agent-session.js:2680`).
- The edit `patch` header repeats the input path as written.

## Summary table

| Source | Event or entry | Path fields | Absolute or relative | Available on resume |
|---|---|---|---|---|
| `read`, `edit`, `write` (live) | `tool_execution_start.args` (raw), `tool_call.input` (prepared), `tool_result.input` | `path` | As the model wrote it: relative to `ctx.cwd`, absolute, `~/`, `@`, `file://` | Yes, as stored arguments |
| `read`, `edit`, `write` (stored) | `message` entry, assistant `toolCall.arguments`; `toolResult` by `toolCallId` for `isError` | `arguments.path` | Same, raw and before `prepareArguments` | Yes, `getBranch()` (includes compacted entries) |
| `ls`, `find`, `grep` | Same events and entries; result `content` | `path` (directory, default `.`), `pattern`, `glob`; result lines | Input as written; result lines relative to the searched directory | Yes |
| `bash` (model) | Same events and entries | `command` string; `details.fullOutputPath` (pi temp file) | None structured | Yes, command only |
| `!` / `!!` and RPC `bash` | `user_bash` | `command`, `cwd` | `cwd` absolute | Yes, `bashExecution` message without `cwd` |
| Other extensions' tools, MCP tools | `tool_call` / `tool_result` (`CustomToolCallEvent`) | Any key in `input`; schema from `pi.getAllTools()` | Unknown; MCP paths are relative to the server | Yes |
| Codemode / `ctx.executeTool` | Same events with `parentToolCallId`; parent `toolResult.nestedCalls` | Inner tool's arguments | As the inner tool | Yes, bounded (8 KiB per call, 256 calls) |
| Editor `@` completion | No event; wrapper on `addAutocompleteProvider` sees `applyCompletion(item, prefix)` | `item.value` (`@path`, `@"path"`) | Relative to the session cwd unless typed with `~/` or `/` | No; only the sent text |
| Sent user text | `input.text`, `before_agent_start.prompt`, `message_end` (user) | `@` tokens and pasted paths, as text | As typed | Yes, user message |
| CLI `@file` | `input.text` with `source: "interactive"` | `<file name="…">` | Absolute | Yes, user message |
| Clipboard image (Ctrl+V) | No event; editor text | `<tmpdir>/pi-clipboard-<uuid>.<ext>` | Absolute, temp, never deleted by pi | Text only |
| Copied or dragged files | No event; editor text | Original paths | Absolute | Text only |
| Image attachments (CLI `@image`, RPC, `sendUserMessage`) | `input.images` | None (base64) | n/a | Base64 only |
| Compaction | `session_before_compact.preparation.fileOps`; `compaction.details` | `readFiles`, `modifiedFiles` | Raw mix of forms | Yes |
| Branch summary | `session_tree.summaryEntry`; `branch_summary.details` | `readFiles`, `modifiedFiles` | Raw mix of forms | Yes |
| Session base | `getHeader().cwd`; system message `sections.cwd`; `user_bash.cwd`; `ctx.cwd` | cwd | Absolute | Yes |
| Earlier sessions | `SessionManager.list(ctx.cwd, getSessionDir())` + `parseSessionEntries` | All stored fields above | As stored | Always on disk, unless `--no-session` |

## Open risks

- **Normalization is not exported.** Paths arrive in five forms, and `read` has macOS filename variants. Pi's resolver is not in the package exports, so the extension must reimplement about 30 lines of `utils/paths.js` and `path-utils.js`, and keep them in step with pi.
- **The wrong base cwd.** `forkFrom` copies entries from another project but writes the target cwd into the header (`session-manager.js:1397-1404`). When a stored cwd is missing, the user can continue in the current cwd, so tools resolve against a cwd the header does not record (`pca/dist/core/session-cwd.js:1-37`). Relative paths from such entries resolve wrongly against the header `cwd`. pi-session-resources also uses the current `ctx.cwd`.
- **What counts as "used".** Failed reads (missing files) and blocked or invalid calls still carry a path. Pi's compaction lists count failed reads. `isError` can be flipped by an earlier `tool_result` handler. Ticket #172 must decide whether a path needs a successful call, or only an attempted one.
- **Stored path versus executed path.** A `tool_call` handler that rewrites `input.path` (a sandbox, for example) changes what ran but not the stored `toolCall.arguments`. A `message_end` handler can also replace the stored assistant message (`agent-session.js:940-951`). Live events and resume can therefore disagree.
- **Bash is guesswork.** Any extraction from `command` will miss `cd`, globs and variables. Whether to try at all, and with which rules, is open.
- **`@` completion is fragile.** Seeing an accepted completion needs a delegating provider wrapper, works in the TUI only, needs `fd`, and is hidden by any later wrapper that does not delegate. The sent text is the reliable record, but it has to be parsed.
- **Noise from temp files.** `pi-clipboard-*`, `pi-bash-*.log`, codemode images and MCP binary resources all live in `os.tmpdir()` (`pca/dist/utils/output-files.js:1-17`, `interactive-mode.js:2478-2482`). They can vanish, or stay forever.
- **Privacy and other extensions' state.** Session files carry file contents, command output and other extensions' `details` and custom entries. A reader must stay inside `getSessionDir()`, pick out only the fields listed above, and never use `listAll()`. Whether `!!` commands, which the user kept out of the model's context, may become Recent refs is open.
- **Side effects and cost.** `list(cwd)` without a directory creates one, `open()` may rewrite a file, and `list()` reads every session file in full. Earlier-session scans need a bound and an abort signal.
- **`session_start` is not a clean "resume" signal.** `--continue` reports `"startup"`, and RPC `switch_session` fires it twice. A rebuild must be idempotent and must not depend on `reason`.
- **Nested-call records are lossy.** Arguments over 8 KiB are dropped and `complete: false` is set, so some codemode paths exist only in the live events.
- **Timestamps.** Parallel calls finish out of order. Recency should come from the event time or the stored message `timestamp`, not from event order.
