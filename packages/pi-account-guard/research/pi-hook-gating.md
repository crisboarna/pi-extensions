# Research: which pi hooks can stop a turn or a mid-turn model change before a request is sent?

**Scope.** pi monorepo at commit `d5b3de22` (`@earendil-works/pi-coding-agent` 1.4.0, the same version as the user's install). Every citation is `path:line` relative to `/tmp/wf-src/pi`, except citations of the pi-multi-pass package, which give the installed path `~/.pi/agent/npm/node_modules/pi-multi-pass/...`. Anything that could not be confirmed in source is marked **unverified**.

**Bottom line.**
- No extension hook in pi 1.4.0 can veto a provider request by throwing or by its return value, except `input`, which can return `{ action: "handled" }` for user-typed input.
- Every other request-time hook swallows handler errors and continues. In other words, it fails open.
- The only way for an extension to stop work that is already in flight is `ctx.abort()`.
- The most reliable gate is a guard that checks the account in a per-request hook (`context`) and calls `ctx.abort()` when the check fails. Entry hooks (`input`, `before_agent_start`) and `model_select` add earlier rejection and better user feedback.

---

## 1. Does `input` returning `{ action: "handled" }` stop the turn in every mode? Which turns pass through `input`?

**Verdict.** Yes. For input that reaches `AgentSession.prompt()`, `steer()` or `followUp()`, a `handled` result stops it in every mode before any run starts or any message is queued. Several ways of starting work never reach `input`, however. They are listed below.

**Evidence.**
- The runner stops at the first handler that returns `handled` and skips later handlers (`packages/coding-agent/src/core/extensions/runner.ts:1525-1567`, short-circuit at `:1546`).
- A handler that throws is caught and reported through `emitError`, and the loop moves on to the next handler (`runner.ts:1553-1558`). **A throwing `input` handler fails open.**
- `AgentSession._runInputHandlers` returns `undefined` on `handled` (`packages/coding-agent/src/core/agent-session.ts:2051-2054`).
- `prompt()` then returns before any expansion, queueing or `_startRun` (`agent-session.ts:2116-2126`).
- `_queueUserInput`, used by `steer()` and `followUp()`, returns the disposition `"handled"` without queueing (`agent-session.ts:2237-2253`).
- All three modes call these methods:
  - Interactive: `interactive-mode.ts:1257`, `:3338`, `:4488`, `:4800-4802`, `:4840-4842`, all under `packages/coding-agent/src/modes/interactive/`.
  - Print: `packages/coding-agent/src/modes/print-mode.ts:132` and `:136`.
  - RPC: `packages/coding-agent/src/modes/rpc/rpc-mode.ts:394-424`.

**How a handled input looks in each mode.**
- **Interactive:** the prompt silently does nothing. The extension must notify the user itself.
- **Print (`-p`):** `prompt()` returns normally, so `runPrintMode` reaches its exit-code logic. In text mode, exit code 1 is set only if the last message is an assistant message with `stopReason` `error` or `aborted` (`print-mode.ts:139-162`). In a fresh session there is no assistant message, so the process **exits 0 with no output**. Section 8 covers how to force a failure.
- **RPC:** the `prompt` command gets a **success** response with `disposition: "handled"` (`rpc-mode.ts:403-405`, fed by `agent-session.ts:2124`). `steer` and `follow_up` likewise return success with disposition `"handled"` (`rpc-mode.ts:416-424`).

**Which paths pass through `input`.**

| Path | Through `input`? | Evidence |
|---|---|---|
| Typed prompt (interactive), `-p` messages, RPC `prompt` | Yes | `agent-session.ts:2116-2122` |
| Steering / follow-up typed while streaming (TUI, RPC `steer` / `follow_up`, interactive compaction queue) | Yes, with `streamingBehavior` set | `agent-session.ts:2121`, `:2275-2297`, `:2237-2253`; `interactive-mode.ts:4795-4844` |
| `pi.sendUserMessage()` (idle or `deliverAs` steer/followUp) | Yes, with `source: "extension"` | `agent-session.ts:2429-2459` (calls `prompt` with `source: "extension"` at `:2457`) |
| Skill invocations `/skill:name` and prompt templates `/tpl` | Yes, but `input` sees the **raw, unexpanded** text starting with `/` | Expansion happens after `input` (`agent-session.ts:2116`, `:2130-2134`; queued path `:2254-2255`) |
| Extension commands `/cmd` (registered with `pi.registerCommand`) | **No.** They run before `input` | `agent-session.ts:2099-2108` |
| `pi.sendMessage(..., { triggerTurn: true })` while idle | **No.** Calls `_startRun` directly | `agent-session.ts:2378-2383` |
| `pi.sendMessage(...)` while streaming (steer / followUp) | **No.** Pushed straight to `agent.steer` / `agent.followUp` | `agent-session.ts:2372-2377` |
| Auto-retry, queued-work continuations, `agent_before_settle` / `turn_end` continuations | **No.** These use `agent.continue()` | `agent-session.ts:1898-1909` |

**`source` values.** `InputSource = "interactive" | "rpc" | "extension"` (`packages/coding-agent/src/core/extensions/types.ts:1168`). The event also carries `streamingBehavior?: "steer" | "followUp"`, which is undefined when idle (`types.ts:1171-1181`). Print mode calls `prompt()` without a source, so its input arrives as **`"interactive"`** (`print-mode.ts:132`, default at `agent-session.ts:2120`). A guard must use `ctx.mode` to tell print from TUI.

**Observed gap in pi-multi-pass.** Its `input` guard returns `continue` for any text that starts with `/` (`~/.pi/agent/npm/node_modules/pi-multi-pass/extensions/multi-sub.ts:7622-7628`). Because skills and prompt templates reach `input` unexpanded, **`/skill:...` and `/template` prompts bypass its restriction.** It also allows everything when no project config exists (`multi-sub.ts:7545-7549`).

---

## 2. Can `before_agent_start` cancel a run? What happens when a handler throws?

**Verdict.**
- **A return value cannot cancel.** The result type has only `message` and `systemPrompt` fields (`types.ts:1496-1500`).
- **A throw fails open.** The error is reported and the run continues (`runner.ts:1427-1477`, catch at `:1465-1472`).
- **`ctx.abort()` called inside `before_agent_start` does stop the run before the first provider request.**

**Evidence for the abort path.**
- `_startRun` marks the session busy (`_isAgentRunActive = true`, `_agentRunAbortRequested = false`) before `_prepareRun` emits `before_agent_start` (`agent-session.ts:1873-1878`, `:1935`).
- `AgentSession.abort()` sets `_agentRunAbortRequested = true` whenever a run is active (`agent-session.ts:2498-2501`).
- At that point no low-level agent run exists yet, so `agent.abort()` does nothing (`packages/agent/src/agent.ts:350-352`).
- pi applies the pending abort when the run emits `agent_start`. The source comments: "An abort requested while the run was starting, e.g. during before_agent_start, stops it here. agent_start is awaited before the first request" (`agent-session.ts:1104-1106`).
- The agent loop emits `agent_start` and awaits its listeners before any request (`packages/agent/src/agent-loop.ts:126`, `:155`; listeners awaited at `agent.ts:619-621`).
- `ctx.abort()` reaches `session.abort()` in every mode (`agent-session.ts:3502-3508`). In the TUI it goes through the interactive `abortHandler`, which also restores queued messages to the editor before calling `session.abort()` (`interactive-mode.ts:1978-1980`, `:4734-4752`).

**Coverage.** `before_agent_start` fires for user prompts (`messageType: "user"`, including `pi.sendUserMessage`) and for idle `pi.sendMessage(..., { triggerTurn: true })` (`messageType: "custom"`) (`types.ts:940-957`). It does **not** fire for `agent.continue()` runs such as retries or continuations (`agent-session.ts:1898-1909`).

**Unverified.** After such an abort, the persisted transcript probably contains the user message followed by an aborted assistant message. The agent loop still runs `context` handlers and calls the stream function, which should fail on the aborted signal. Whether every transport refuses before touching the network was not traced end to end.

---

## 3. Can `before_provider_request` or `before_provider_headers` abort a request? Which transports skip them?

**Verdict.** Neither hook can abort through its return value or a throw.

**Return values and throws.**
- `before_provider_request`: any non-`undefined` return **replaces the payload**, and a throw is caught and reported while the request continues (`runner.ts:1368-1397`).
- `before_provider_headers`: the return value is ignored and a throw is caught (`runner.ts:1399-1425`; documented at `types.ts:906-914`). Handlers mutate headers in place, and `null` deletes a header.
  - Deleting auth headers is **not** a gate. The request, including the prompt text, still goes to the provider without credentials.

**Calling `ctx.abort()` inside these hooks.** This is weaker than in `context`:
- Built-in providers check the signal **before** `onPayload` but not after. For example, Anthropic calls `throwIfAborted()` at `packages/ai/src/api/anthropic-messages.ts:650` and `onPayload` at `:654`, then sends with the signal in `requestOptions` (`:643-644`).
- `retryProviderRequest` makes the first attempt without checking the signal; it checks only after a failure (`packages/ai/src/utils/provider-retry.ts:112-119`).
- Whether an already-aborted signal stops the SDK or `fetch` from sending bytes is standard `fetch` behaviour, not pi code. **Unverified for pi.**

**What the handlers can see.**
- `onPayload` receives `(payload, model)` (`packages/ai/src/types.ts:181`), but pi forwards only the payload to extensions (`packages/coding-agent/src/core/sdk.ts:374-378`; event shape `types.ts:900-904`).
- So the handler cannot see which model the request goes to. It sees only `ctx.model`, the session's **selected** model.

**Which transports skip these hooks.**
- `before_provider_headers` runs inside `ModelRuntime.prepareRequest` for **every** provider, including extension providers (`packages/coding-agent/src/core/model-runtime.ts:679-690`, wired through `sdk.ts:353-356`). The headers only matter if the provider implementation uses `options.headers`.
- `before_provider_request` runs only when the provider implementation calls `options.onPayload`.
  - All built-in APIs do (`packages/ai/src/api/*.ts`, for example `anthropic-messages.ts:654`, `openai-responses.ts:211`, `openai-codex-responses.ts:283`, `openai-completions.ts:373`, `google-generative-ai.ts:96`, `bedrock-converse-stream.ts:288`, `mistral-conversations.ts:149`, `pi-messages.ts:396`).
  - Custom providers registered with `streamSimple` are **required by contract, not by code**, to call `options.onPayload` (`types.ts:1944-1955`).
  - The docs say: "Provider hooks run only when that transport exposes the corresponding stage" (`packages/coding-agent/docs/extensions.md:125`).
  - A grep of the installed `pi-claude-bridge/src` found **no `onPayload` call**, so `before_provider_request` most likely never fires for `claude-bridge` requests. This was one grep, not a full read of the bridge.
- **Virtual models** (`pi.registerVirtualModel`) have no transport of their own. `prepareRequest` routes each request to a physical model (`agent-session.ts:812-843`), and that model's provider decides whether the hooks fire. `ctx.model` stays the virtual selection (`types.ts:1906-1915`).

---

## 4. `model_select` during a running turn

**What the event carries.** `{ model, previousModel, source }` with `source: "set" | "cycle" | "restore"` (`types.ts:1131-1139`).
- Only `"set"` (from `setModel`) and `"cycle"` are emitted in 1.4.0 (`agent-session.ts:2560`, `:2629`, `:2661`). No call site emits `"restore"`.
- The event is skipped when the new model equals the previous one (`agent-session.ts:2526`).
- There is no "reason" field and no turn or streaming flag. A handler must call `ctx.isIdle()` to know whether a turn is running (`types.ts:347-348`).

**Can a handler abort the running turn?** Yes, with `ctx.abort()` (section 2). After an abort:
- `_startRun`'s loop stops (`agent-session.ts:1900-1907`).
- `_handlePostAgentRun` refuses retries (`agent-session.ts:1983-1997`).
- The agent's abort controller is aborted at once (`agent.ts:350-352`).

**The new model takes effect on the next request.**
- `createLoopConfig` snapshots `state.model` at run start (`agent.ts:479`).
- Before **every** request, `prepareRequest` re-reads `this.agent.state.model` (`agent-session.ts:812`), and the loop applies the result (`agent-loop.ts:228-250`).

**Race.** `setModel` writes `this.agent.state.model` **before** it awaits `model_select` (`agent-session.ts:2548` vs `:2560`; same order in both cycle paths, `:2615`/`:2629` and `:2650`/`:2661`).
- **No race when `setModel` runs inside the agent's awaited event chain.** Examples: pi-multi-pass rotation in its `agent_end` handler (`multi-sub.ts:7639`, `setModel` at `:3765`), a `turn_end` handler, or a tool. The agent awaits every listener before continuing (`agent.ts:619-621`), and the retry or continuation starts only afterwards.
- **A race is possible when `setModel` runs outside the loop.** Examples: RPC `set_model` (`rpc-mode.ts:476`), interactive model cycling or the selector (`interactive-mode.ts:4532`, `:5342`).
  - JavaScript is single-threaded, but any `await` in a `model_select` handler that runs before the guard's handler yields to the loop. pi-multi-pass's handler awaits `pi.setModel` (`multi-sub.ts:7560`, `:7618-7620`).
  - The loop could then reach `prepareRequest` and stream to the new model before the guard's handler runs.
  - Whether the TUI blocks model changes while streaming is **unverified**. No streaming check was seen at the RPC call site.

**Does pi's own retry change the model?** No.
- `_prepareRetry` only counts, emits `auto_retry_start`, hides the failed attempt and sleeps (`agent-session.ts:3822-3866`). It does not change the model and does not emit `model_select`.
- **Exception:** with a virtual model selected, every request (including retries, `reason: "retry"`) is re-routed by `route()`, which may pick a different physical model with no `model_select` (`agent-session.ts:816-843`).

---

## 5. Is there another hook before every provider request that can veto it? Which gate is strongest?

**Hooks that run before every request**, in order (`docs/extensions.md:95-101`):

1. `prepareRequest`. This is internal, not an extension hook. It picks the model, and for virtual models it calls `route()` (`agent-session.ts:787-845`).
2. `context` / `context_with_system`, through `transformContext` in `streamAssistantResponse` (`agent-loop.ts:399-401`; wired at `sdk.ts:428-432`).
   - This runs for **every** request whatever the transport, because it lives in the agent loop and not in the provider adapter.
   - Throws are swallowed (`runner.ts:1305-1366`).
   - At this point the request's model is already fixed (`agent-loop.ts:228-250` runs before `:399`). For physical models `ctx.model` equals the request model, unless it changed after `prepareRequest`.
3. `before_provider_headers` (`model-runtime.ts:690`).
4. `before_provider_request` (only if the provider calls `onPayload`).

**Other hooks.**
- `turn_start` is a notification. It is emitted at `agent-loop.ts:127`, `:156` and `:216`, and has no veto.
- A virtual model's `route()` can fail closed: "A routing failure rejects, which ends the run with an error response" (`agent-session.ts:816-818`). It only applies while that virtual model is selected, so it cannot guard physical accounts.

**Verdict.** No hook vetoes by its return value or by throwing. The strongest fail-closed gate available to an extension is:

- **`context` handler + `ctx.abort()`.** It runs for every request on every transport, before the stream function is called. Inside the stream function, auth resolution and adapters check the signal; for example `packages/ai/src/auth/resolve.ts:53` and `anthropic-messages.ts:650`.
  - That a request is never sent after an abort here is likely but **unverified for every transport, especially `claude-bridge`**.
  - The handler must catch its own errors and treat any doubt as "abort". pi will not fail closed on its behalf. The docs ask gate handlers to "fail closed when their safety decision cannot be made" (`docs/extensions.md:214`), but the runner does not enforce it.

**Separate request source: the cache warmer.** It sends keep-alive requests outside turns (`packages/coding-agent/src/core/cache-warmer.ts:330-337`).
- These reuse the last request's options, so `onPayload` and `transformHeaders` should still apply. This is inferred from `sdk.ts:418-424`.
- It only warms while the selected model equals the request model (`sdk.ts:362-374`).
- A guard can stop it explicitly by returning `{ action: "stop" }` from `cache_warming_decision` (`runner.ts:1126-1145`).

---

## 6. Does `session_start` fire again when `/new`, `/resume` or `/fork` changes the directory? Where does `ctx.cwd` come from?

**Verdict.** Yes. Each replacement builds a new runtime with fresh services, a fresh extension runner and the target session's directory, then emits `session_start` with `reason` set to `"new"`, `"resume"` or `"fork"`.

**Evidence.**
- Resume uses `cwd: sessionManager.getCwd()` (`packages/coding-agent/src/core/agent-session-runtime.ts:215-218`).
- New uses `cwd: this.cwd` (`:248-251`).
- Fork uses `this.cwd` or the session's directory (`:302-305`, `:323-326`, `:342-345`).
- Before replacement, the old session is aborted and `session_shutdown` is emitted (`agent-session-runtime.ts:167-176`).
- `finishSessionReplacement` calls each mode's `rebindSession`, which calls `bindExtensions` (`agent-session-runtime.ts:185-188`; for example `print-mode.ts:69-76`).
- `bindExtensions` emits the stored `sessionStartEvent` (`agent-session.ts:3339`).
- Reload emits `session_start` with `reason: "reload"` (`agent-session.ts:3755`). The event type lists `"startup" | "reload" | "new" | "resume" | "fork"` (`types.ts:755-761`).

**Where `ctx.cwd` comes from.**
- `ExtensionRunner` gets the session's `_cwd` in its constructor (`agent-session.ts:3697-3703`).
- `ctx.cwd` returns `runner.cwd` (`runner.ts:901-903`).
- Every runtime factory call creates `createAgentSessionServices({ cwd, ... })` for that directory (`packages/coding-agent/src/main.ts:733-752`).

**`project_trust` is not a reliable directory hook.** It fires only when all of these hold:
- the directory has trust-requiring project resources,
- no `--trust` override is set,
- the decision is not cached for that directory in the current process (`main.ts:741-746`; `packages/coding-agent/src/core/project-trust.ts:47-79`).

The first handler that returns yes or no wins (`runner.ts:301-325`).

---

## 7. Extension load order and handler ordering

**Handler order.** `snapshotEventHandlers` walks the extensions array in order, and each extension's handlers in registration order (`runner.ts:276-278`). Every `emit*` method uses it.

**Extensions array order.**
1. CLI `-e` paths come first. They are merged ahead of resolved paths (`packages/coding-agent/src/core/resource-loader.ts:718-727`). That `mergePaths` keeps first-argument order is **unverified**.
2. Resolved resources are stable-sorted by precedence rank (`packages/coding-agent/src/core/package-manager.ts:196-216`, sort at `:2677`):
   - project `settings.extensions` entries
   - project auto-discovered `.pi/extensions/`
   - user `settings.extensions` entries
   - user auto-discovered `~/.pi/agent/extensions/`
   - **packages**
   - built-ins
3. Within packages, project-scope packages come before user-scope packages, each in `settings.json` `packages` order. Duplicates are removed, and the project copy wins (`package-manager.ts:941-951`). That per-package resource order follows list order is **unverified** (`resolvePackageSources` was not read).
4. Inline extension factories are appended last (`resource-loader.ts:740-742`).

**Can the guard guarantee it runs after pi-multi-pass?**
- There is no priority API. None was found in `types.ts` or the loader.
- The guard runs after pi-multi-pass only when both are packages and the guard is listed **after** pi-multi-pass in the same scope's `packages` list, or the guard is user-scope while pi-multi-pass is project-scope.
- Installing the guard as a local extension (`~/.pi/agent/extensions/`, a `settings.extensions` entry, or `-e`) makes it run **before** every package, including pi-multi-pass.
- Order matters for `input` and `model_select`. pi-multi-pass may call `setModel` in those handlers (`multi-sub.ts:7560`, `:7618-7628`). A guard that runs first sees the model before the switch.

---

## 8. Hard failure in print and RPC modes; `ctx.ui.notify` and `ctx.hasUI`

**Print and JSON modes (`-p`, `--mode json`).**
- `bindExtensions` gets no `uiContext`, so the runner uses `noOpUIContext` (`print-mode.ts:73-104`; `runner.ts:572-575`, `:331-361`).
- `ctx.hasUI` is `false` (`runner.ts:628-630`, `:897-900`), and `ctx.mode` is `"print"` or `"json"` (`print-mode.ts:77`).
- `ctx.ui.notify` does nothing (`runner.ts:335`), and `select` / `confirm` resolve to `undefined` / `false`.
- Extension errors are printed to stderr (`print-mode.ts:101-103`).

**Exit codes in print mode.**
- `runPrintMode` returns 1 only if `prompt()` throws, or, in text mode, if the last assistant message has stopped with `error` or `aborted` (or hit the length limit) (`print-mode.ts:139-165`).
- So a `ctx.abort()` gate gives exit 1 in text mode, with "Request aborted" or the error message on stderr. This is inferred from `:145-147` and not run.
- A `handled` input gives exit 0. JSON mode returns 0 unless `prompt()` throws.
- `ctx.shutdown()` does nothing in print mode, because no `shutdownHandler` is bound (`print-mode.ts:73-104`; `agent-session.ts:3510-3512`). This contradicts the docstring "Available in all contexts" (`types.ts:357`).
- **A reliable signal:** the guard writes its reason to stderr and sets `process.exitCode = 1`. `main` only overwrites `process.exitCode` when print mode returns a non-zero code, then returns without `process.exit` (`main.ts:988-999`).

**RPC mode.**
- A real UI context is bound, so `ctx.hasUI` is `true` (`rpc-mode.ts:319-321`; docs at `types.ts:330-331`).
- `notify` sends `{ type: "extension_ui_request", method: "notify", message, notifyType }` on stdout (`rpc-mode.ts:152-160`). Dialog methods also work over RPC.
- Extension errors are sent as `{ type: "extension_error", ... }` (`rpc-mode.ts:348-350`).
- A `handled` prompt returns **success** with `disposition: "handled"` (`rpc-mode.ts:403-405`). A client cannot tell it apart from an intentional handle unless the guard also sends a notify or error event.
- `ctx.shutdown()` sets `shutdownRequested`, and the process later exits with code 0 (`rpc-mode.ts:345-347`, `:727-748`).

**Interactive mode.**
- `ctx.hasUI` is true. `notify` renders in the TUI.
- `ctx.shutdown()` exits once idle (`interactive-mode.ts:2030-2035`).
- Extension errors are shown with `showExtensionError` (`:2036-2038`).

---

## Implications for pi-account-guard

### Recommended gate points (defence in depth)

1. **`input`** (fires first; only user and `sendUserMessage` input). Return `{ action: "handled" }` when the account is not allowed.
   - In the TUI, offer the allowed-account picker.
   - In print mode, write to stderr and set `process.exitCode = 1`.
   - In RPC, send `ctx.ui.notify(..., "error")`.
   - Check `/skill:` and template text too. Do not skip text starting with `/`, as pi-multi-pass does.
2. **`before_agent_start`.** Call `ctx.abort()` when the account is not allowed. This covers idle `pi.sendMessage({ triggerTurn: true })`, which never reaches `input`, and acts as a second check.
3. **`context`, the main per-request gate.** On every request, recompute the allow decision from `ctx.model.provider` and `ctx.cwd`, and call `ctx.abort()` when it fails.
   - This covers mid-turn `setModel` from any source, out-of-loop races, retries, continuations, steering, custom messages and transports without `onPayload` (such as `claude-bridge`).
   - Wrap the whole handler in try/catch and abort on any error.
4. **`model_select`.** When `!ctx.isIdle()` and the new account is not allowed, call `ctx.abort()` and notify. This is an early abort and gives user feedback; correctness rests on gate 3.
5. **`before_provider_request`** (optional extra check). Abort here too. Its effect on a request that is already being built is unverified.
6. **`cache_warming_decision`.** Return `{ action: "stop" }` when the account is not allowed.
7. **`session_start`** (all reasons). Re-resolve the Place from `ctx.cwd` and check the current model, so a resumed or forked session in another directory is caught before its first prompt.

### Known gaps

- **No fail-closed hook.** Every listed hook swallows throws: `input`, `before_agent_start`, `context`, `before_provider_*` and `emit` (`runner.ts:1553-1558`, `:1465-1472`, `:1324-1333`, `:1384-1393`, `:1412-1421`, `:1110-1118`). The guard must fail closed itself by catching errors and calling `ctx.abort()`.
- `ctx.abort()` stops work through the abort signal. That no bytes reach the provider after an abort in `context` is **unverified per transport**. This is a particular concern for `claude-bridge`, which does not call `onPayload` and whose signal handling was not read.
- A virtual model's routed physical model is invisible to extensions. `ctx.model` is the virtual selection, `before_provider_request` gets no model argument, and re-routing on retry fires no `model_select`. This matches the agreed v1 decision to tag virtual models as accounts.
- `model_select` is not emitted on session restore or resume (no `"restore"` call site). Use `session_start` instead.
- A handled `input` exits 0 in print mode and is a success in RPC. The guard must signal failure explicitly.
- The guard cannot choose its order relative to pi-multi-pass except through `packages` list order.
- Not covered here, and out of scope for the map: subagent child processes, compaction or summary requests (`completeSimple` paths were not traced; **unverified** whether they pass `context`), and other extensions' own HTTP clients.

### Facts the design must cite

1. `input` `handled` short-circuits; a throwing handler is skipped (`runner.ts:1546`, `:1553-1558`; `agent-session.ts:2116-2126`, `:2237-2253`).
2. `InputSource = "interactive" | "rpc" | "extension"`; print mode sends `"interactive"` (`types.ts:1168`; `agent-session.ts:2120`; `print-mode.ts:132`).
3. Extension commands skip `input` (`agent-session.ts:2099-2108`). Skills and templates reach `input` unexpanded (`agent-session.ts:2116`, `:2130-2134`).
4. `sendMessage({ triggerTurn })` skips `input` (`agent-session.ts:2378-2383`), and while streaming it skips both `input` and `before_agent_start` (`:2372-2377`).
5. `before_agent_start` cannot cancel and fails open; `ctx.abort()` during it stops the run at `agent_start` (`types.ts:1496-1500`; `runner.ts:1465-1472`; `agent-session.ts:1104-1106`, `:1873-1878`).
6. `before_provider_request` / `before_provider_headers` cannot veto (`runner.ts:1368-1425`). `onPayload` depends on the transport (`types.ts:1944-1955`; `docs/extensions.md:125`).
7. The model is re-read before every request (`agent-session.ts:812`; `agent-loop.ts:228-250`). `setModel` writes state before emitting `model_select` (`agent-session.ts:2548`, `:2560`).
8. The agent awaits listeners in order (`agent.ts:619-621`), so model changes made inside event handlers are race-free, while RPC and TUI model changes are not (`rpc-mode.ts:476`; `interactive-mode.ts:4532`, `:5342`).
9. pi's retry never changes the model (`agent-session.ts:3822-3866`). Virtual routing can, without notice (`agent-session.ts:816-843`).
10. `context` runs before every request on every transport (`agent-loop.ts:399-401`; `sdk.ts:428-432`).
11. `session_start` fires again with a fresh runner and directory on new, resume, fork and reload (`agent-session-runtime.ts:215-218`, `:248-251`, `:302-345`; `agent-session.ts:3339`, `:3697-3703`; `runner.ts:901-903`).
12. Handler order is extension array order: CLI, then project local, then user local, then packages in settings order (project before user), then built-ins; there is no priority API (`runner.ts:276-278`; `package-manager.ts:196-216`, `:941-951`, `:2677`; `resource-loader.ts:718-742`).
13. Print mode: no UI, `notify` does nothing, `shutdown` does nothing, and the exit code comes only from the last assistant message or a throw; `process.exitCode` survives (`print-mode.ts:73-165`; `runner.ts:331-361`, `:572-575`, `:628-630`; `main.ts:988-999`).
14. RPC: `hasUI` is true, `notify` becomes an `extension_ui_request` event, a handled prompt is a success with `disposition: "handled"`, and errors become `extension_error` events (`rpc-mode.ts:152-160`, `:319-350`, `:394-424`).
15. pi-multi-pass allows everything without config and skips `/` input (`multi-sub.ts:7545-7549`, `:7622-7628`). It rotates in `agent_end` and may queue a follow-up with `sendUserMessage` (`multi-sub.ts:7639`, `:3765`, `:3792-3794`).
