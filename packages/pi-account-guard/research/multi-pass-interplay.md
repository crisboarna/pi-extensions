# How pi-multi-pass restriction and rotation interact with an independent account guard

Research for the ticket "How do pi-multi-pass restriction and rotation interact with a second guard?" (pi-account-guard design map).

## Sources and citation keys

All claims come from reading package source code. The citations use these short paths:

- `multi-sub.ts`: `~/.pi/agent/npm/node_modules/pi-multi-pass/extensions/multi-sub.ts` (pi-multi-pass 1.12.0, 7878 lines)
- `README.md`: `~/.pi/agent/npm/node_modules/pi-multi-pass/README.md`
- `agent-session.ts`: `/tmp/wf-src/pi/packages/coding-agent/src/core/agent-session.ts` (pi 1.4.0)
- `runner.ts`: `/tmp/wf-src/pi/packages/coding-agent/src/core/extensions/runner.ts`
- `types.ts`: `/tmp/wf-src/pi/packages/coding-agent/src/core/extensions/types.ts`

Anything that depends on `pi-agent-core` internals, such as the agent queue and how the agent loop awaits listeners, was not read. Those points are marked **unverified**.

## Background: pi core semantics that matter

- **`pi.setModel` always emits `model_select`.** The extension binding returns `false` when the provider has no configured auth. Otherwise it calls `session.setModel` and returns `true` (`agent-session.ts:3488-3492`, contract at `types.ts:1791-1795`). `session.setModel` sets `agent.state.model` (`agent-session.ts:2548`) and then awaits `_emitModelSelect(..., "set")` (`agent-session.ts:2560`). That function skips the emit when the old and new models are equal (`agent-session.ts:2526`). Every multi-pass model change therefore reaches the guard's `model_select` handler, whichever code path made it.
- **`model_select` cannot be vetoed.** It goes through the generic `emit()`. Every handler runs in extension load order. Return values are ignored except for `session_before_*` events, and a thrown error is reported and the loop continues (`runner.ts:1096-1125`). Handler order is the extension array order (`runner.ts:276-277`). The only way the guard can stop anything from `model_select` is `ctx.abort()`.
- **`ctx.abort()` only acts on an active run.** `ctx.abort()` calls the runtime abort (`runner.ts:937-940`), which calls `void this.abort()` unless a mode installs `_extensionAbortHandler` (`agent-session.ts:3502-3508`). `abort()` sets `_agentRunAbortRequested` only when `_isAgentRunActive` is true (`agent-session.ts:2498-2501`). It also cancels any pending auto-retry (`agent-session.ts:2502`). `_startRun` sets `_isAgentRunActive = true` and resets `_agentRunAbortRequested = false` (`agent-session.ts:1874-1875`). So an abort requested while pi is idle is dropped, and it does not carry over to the next run.
- **An abort stops retries and continuations.** The run loop exits when the flag is set (`agent-session.ts:1900-1903`). `_handlePostAgentRun` returns `false` before the retry check and the queued-message check when the flag is set (`agent-session.ts:1982-1985`, `agent-session.ts:1988`, `agent-session.ts:2014`).
- **An abort during `before_agent_start` stops the run.** `before_agent_start` is emitted inside `_prepareRun` (`agent-session.ts:1935`), after `_startRun` has set the run active. The code says an abort requested while the run is starting "e.g. during before_agent_start, stops it" at `agent_start` (`agent-session.ts:1104-1106`).
- **`input` is a short-circuit chain.** Handlers run in load order. The first `handled` result returns immediately, and later handlers do not run. `transform` results chain. A thrown error is reported and the chain continues (`runner.ts:1524-1564`; result type at `types.ts:1184-1187`). `handled` means the prompt is dropped (`agent-session.ts:2051-2053`).
- **Some text never reaches `input`, and some is expanded after it.** In `prompt()`, `/name` text that matches a registered extension command runs the command before any `input` handler sees it (`agent-session.ts:2101-2108`). `input` handlers run next (`agent-session.ts:2117-2122`). Skill commands and prompt templates are expanded only after that (`agent-session.ts:2131-2134`). When streaming, the prompt is queued as steer or follow-up (`agent-session.ts:2136-2149`). Otherwise the model and auth are validated and `_startRun` begins (`agent-session.ts:2153-2172`).
- **Replays from extensions go through `input` too.** `pi.sendUserMessage` calls `prompt()` with `source: "extension"` and `streamingBehavior = deliverAs` (`agent-session.ts:2429-2458`). So it passes through every `input` handler. The runtime binding does not await it and reports failures as `send_user_message` errors (`agent-session.ts:3457-3465`). Runs started by `sendUserMessage` also fire `before_agent_start` (`types.ts:940-947`).
- **`isStreaming` covers the whole run.** `isStreaming` equals `_isAgentRunActive` (`agent-session.ts:1479-1481`). That flag is cleared only in `_emitAgentSettled` (`agent-session.ts:1080`). So inside an `agent_end` handler the session is still streaming, and a `sendUserMessage(..., {deliverAs:"followUp"})` call is queued, not started.
- **`agent_end` handlers run before the post-run decision.** Extension handlers get each agent event first (`agent-session.ts:1143`). The `agent_end` listener event carries `willRetry`, which is false when an abort was requested (`agent-session.ts:1144`, `agent-session.ts:1200-1210`). Multi-pass assumes its `agent_end` handler finishes before pi decides on a retry, because it logs "waiting for pi to retry the turn" (`multi-sub.ts:3796-3797`). Whether pi-agent-core awaits the async listener before `agent.prompt()` resolves is **unverified**, because that package was not read.
- **The context model is live.** It is read through `getModel: () => this.model` (`agent-session.ts:3497`). Inside a nested `model_select` emission, `ctx.model` can therefore differ from `event.model`. See question 3.

## 1. Every multi-pass `pi.setModel` call site

**Verdict:** Multi-pass calls `pi.setModel` in seven places. Only one of them, rate-limit failover, happens inside a run. Only that path re-sends the user prompt, and only when pi will not retry the error itself. All other switches happen while pi is idle, or inside an `input` handler before the run starts, and none of them re-send anything.

### 1a. Project restriction

- **Code:** `enforceProjectRestriction`, `multi-sub.ts:7540-7579`; the call is at `multi-sub.ts:7560`.
- **Triggers:** it is called from three handlers:
  - `session_start` (`multi-sub.ts:7614`): at session start, pi is idle.
  - `model_select` (`multi-sub.ts:7617-7619`): whenever any model change happens, from any source, at any time. This includes during a run, as a nested reaction to a rotation.
  - `input` (`multi-sub.ts:7621-7627`): before the turn starts, inside the `input` chain.
- **What it does:** If the project has an `allowedSubs` list and the current provider is not in it (`multi-sub.ts:7547-7552`), it walks the allowed providers in order (`multi-sub.ts:2540-2561`). It picks the first provider that has auth and a model with the current model id or a base-catalog model (`multi-sub.ts:2575-2600`), calls `pi.setModel`, and notifies "switched to …" (`multi-sub.ts:7558-7567`).
- **Re-entrancy:** a module flag makes nested calls return `true` immediately (`multi-sub.ts:7539`, `multi-sub.ts:7544`, `multi-sub.ts:7568-7570`).
- **Re-send:** none. In the `input` path, the original prompt continues on the new model (`multi-sub.ts:7626`).

### 1b. Rate-limit failover across pools and chains

- **Code:** `PoolManager.handleError`, `multi-sub.ts:3697-3804`; the call is at `multi-sub.ts:3765`. It is called from the `agent_end` handler (`multi-sub.ts:7639-7678`).
- **Trigger:** all of these must hold:
  - the last message is an assistant message with `stopReason === "error"` (`multi-sub.ts:7647-7651`)
  - the error matches a rate-limit pattern (`multi-sub.ts:3705`, `multi-sub.ts:2912-2914`)
  - the current provider is a member of a loaded pool (`multi-sub.ts:3707-3708`)
- **Timing:** during the run. This is the `agent_end` of the failed attempt, before pi's auto-retry or continuation.
- **How the next account is chosen:**
  - The current member is marked exhausted with a 5-minute cooldown (`multi-sub.ts:3714`, `multi-sub.ts:3444-3449`, `multi-sub.ts:3209`).
  - A forward-only plan is built from the remaining pool members, then the later entries of the first enabled chain that contains this pool. Members already attempted this turn, exhausted members and unauthenticated members are skipped (`multi-sub.ts:3299-3441`).
  - The plan may be reordered by `quota-first`, `scheduled` or `custom` strategy (`multi-sub.ts:3526-3624`).
  - The first candidate is applied with `pi.setModel` (`multi-sub.ts:3765`).
- **Re-send:**
  - If a prompt was captured and `piWillRetryTurn(error)` is false, multi-pass sets `suppressNextStartTurn` and calls `pi.sendUserMessage(lastUserPrompt, { deliverAs: "followUp" })` (`multi-sub.ts:3792-3795`).
  - `piWillRetryTurn` is true when no HTTP status can be parsed, or when the status is 5xx, 408, 409 or 429 (`multi-sub.ts:2920`, `multi-sub.ts:2929-2933`). In those cases multi-pass relies on pi's own auto-retry, which continues on the newly set `agent.state.model` (`multi-sub.ts:3796-3797`, `agent-session.ts:1988`, `agent-session.ts:2548`).
  - `lastUserPrompt` is captured in `before_agent_start` (`multi-sub.ts:7630-7636`).
- **Config used:** the effective config, which is filtered by `allowedSubs` when a project file exists (`multi-sub.ts:7653`, `multi-sub.ts:7672-7677`). The pools come from `poolManager.loadPools(effective.pools)` at session start (`multi-sub.ts:7584`). Before `session_start`, the constructor loads the unfiltered global pools (`multi-sub.ts:7536-7537`). `agent_end` cannot fire before `session_start`, so this window should not matter in practice; that is inferred, not tested.

### 1c. Presets (`/mp-preset activate` and `/mp-preset <name>`)

- **Code:** `handlePresetActivate`, `multi-sub.ts:7050-7099`; the call is at `multi-sub.ts:7092`. It is reached from the command at `multi-sub.ts:7850` and `multi-sub.ts:7871`, and from the menu at `multi-sub.ts:7187`.
- **Trigger and timing:** a user command. Extension commands run directly, not through `input` (`agent-session.ts:2101-2108`), usually while idle.
- **Restriction:** none. The preset reads the global config (`multi-sub.ts:7055-7058`). Presets are always global in the effective config too (`multi-sub.ts:2466`, `multi-sub.ts:2488`). It takes the first enabled entry that has auth and a model (`multi-sub.ts:7086-7092`) and does not check `allowedSubs`. The resulting `model_select` then triggers project enforcement (1a), which may switch away again.
- **Re-send:** none.

### 1d. `/subs switch`

- **Code:** `handleSubsSwitch`, `multi-sub.ts:4135-4189`; the call is at `multi-sub.ts:4183`.
- **Trigger and timing:** a user command, run directly as an extension command.
- **Restriction:** the options are filtered by the project `allowedSubs` (`multi-sub.ts:4140`, `multi-sub.ts:3857-3868`, `multi-sub.ts:3850-3855`).
- **Re-send:** none.

### 1e. `/subs model` and the `/model` intercept

- **Code:** `handleSubsModel`, `multi-sub.ts:3930-4130`. The calls are at `multi-sub.ts:3989` (no-UI path) and `multi-sub.ts:4123` (TUI picker).
- **Triggers:**
  - `/subs model` (`multi-sub.ts:7733`) or the menu (`multi-sub.ts:6895`).
  - When `interceptModel` is enabled, typed `/model` text is caught in a custom editor's `onSubmit`, before pi's own `/model` handling and before any `input` event (`multi-sub.ts:7400-7455`). The editor is installed at session start (`multi-sub.ts:7612`, `multi-sub.ts:7457-7472`).
- **Timing:** user-driven. The picker can be opened at any time.
- **Restriction:** none. The list is `ctx.modelRegistry.getAvailable()` (`multi-sub.ts:3944`), and `allowedSubs` is not applied. Project enforcement then runs on the resulting `model_select`.
- **Re-send:** none.

### 1f. Session start

Session start has no separate `setModel` call. It runs the project restriction (1a) at `multi-sub.ts:7614` after reloading pools (`multi-sub.ts:7584`).

### Other related facts

- `sendUserMessage` appears exactly once in the file (`multi-sub.ts:3794`).
- No other `pi.on` handlers touch models. The full set is `session_start`, `model_select`, `input`, `before_agent_start` and `agent_end` (`multi-sub.ts:7582-7700`).

## 2. What multi-pass does after the guard aborts a rotation

**Verdict:** Multi-pass stops. It does not rotate again and it does not loop. The member that hit the rate limit stays marked exhausted for 5 minutes. The model stays switched to the account the guard rejected. The prompt replay is either cancelled or left queued (the second case is **unverified**). Nothing creates an infinite loop.

The sequence:

1. Attempt N fails with a rate limit. Multi-pass's `agent_end` handler marks the current member exhausted (`multi-sub.ts:3714`), then calls `pi.setModel(next)` (`multi-sub.ts:3765`).
2. Inside that `await`, pi emits `model_select` (`agent-session.ts:2560`). The guard's handler calls `ctx.abort()`. The run is still active (`agent-session.ts:1080` has not run yet), so `_agentRunAbortRequested` is set and any pending retry sleep is cancelled (`agent-session.ts:2499-2502`).
3. `setModel` returns `true` to multi-pass, so multi-pass treats the rotation as done:
   - It records the new provider as attempted (`multi-sub.ts:3777-3780`) and posts a transition notice and status (`multi-sub.ts:3782-3790`).
   - Then one of two things happens:
     - **pi-retryable error (429, 5xx, or no status):** multi-pass does nothing more. pi's retry does not happen, because `_handlePostAgentRun` returns `false` on the abort flag before `_prepareRetry` (`agent-session.ts:1982-1985`), and the loop exits (`agent-session.ts:1900`). The listener-facing `willRetry` is false (`agent-session.ts:1201`).
     - **Non-retryable error:** multi-pass calls `sendUserMessage(lastUserPrompt, {deliverAs:"followUp"})` (`multi-sub.ts:3794`). This goes through `prompt()`, so every `input` handler sees it with `source: "extension"`, including the guard's (`agent-session.ts:2117-2122`, `agent-session.ts:2457`). The session is still streaming, so the message is queued as a follow-up (`agent-session.ts:2137-2144`). The aborted loop does not start a continuation for it (`agent-session.ts:1982-1985`, `agent-session.ts:2014`). Whether the queued follow-up is later delivered, for example with the next user prompt, or cleared by the abort depends on pi-agent-core and interactive-mode queue handling: **unverified**. `suppressNextStartTurn` stays set (`multi-sub.ts:3793`), so multi-pass skips `startTurn` on the next real turn (`multi-sub.ts:3651-3653`). The worst effect is stale cascade bookkeeping. The cascade resets when the prompt text differs (`multi-sub.ts:3637`, `multi-sub.ts:3659`).
4. The aborted run settles. Multi-pass's `agent_end` reacts only to `stopReason === "error"` (`multi-sub.ts:7647`). It ignores aborted or successful endings and never calls `setModel` itself.

**Loop analysis:**

- **Within one turn:** the failover cascade is forward-only. Each attempted provider and chain index is recorded (`multi-sub.ts:3777-3780`) and skipped later (`multi-sub.ts:3317-3328`, `multi-sub.ts:3378-3392`). The cascade ends with "exhausted" (`multi-sub.ts:3745-3751`). Its length is bounded by the members of the pool and its chain.
- **Across turns:** a new rotation needs a new error, and a new error needs a new run. After an abort, the next run needs a new prompt. The guard's `input` check blocks that prompt while the model is on a rejected account. So each rotation that the guard aborts costs one user action and cannot repeat on its own.
- **Ping-pong between extensions:** multi-pass's `model_select` enforcement does switch automatically (`multi-sub.ts:7617-7619`). It is protected against recursion by `projectRestrictionSwitchInFlight` (`multi-sub.ts:7544`). Because the guard never calls `setModel` on its own (only the picker does, on user choice), the two cannot alternate. A loop would need both extensions to switch models automatically. That is a strong reason to keep the "never auto-switch" rule.
- **Picker override:** if the guard's picker selects an account that is in the guard's zone but not in multi-pass's `allowedSubs`, multi-pass immediately switches away from it (`multi-sub.ts:7550-7560`). The guard then sees a second `model_select`. This ends after one step. To the user it looks as if the choice was overridden.

## 3. Both extensions on `input`: load order and the automatic switch

**Verdict:** Load order decides the outcome. If multi-pass loads first, its automatic switch happens before the guard's `input` handler runs. If the guard loads first and continues, multi-pass's switch happens after the guard's check, while pi is idle. In that case a `ctx.abort()` from the guard's `model_select` handler is dropped, and the turn starts on the switched account. To be safe in both orders, the guard must check again inside the run, at `before_agent_start`.

**Short-circuit:** the first `handled` wins and later handlers never run (`runner.ts:1546`). Multi-pass returns `handled` only when the project is restricted and it cannot find an allowed provider. Otherwise it returns `continue`, possibly after switching (`multi-sub.ts:7625-7626`). It always returns `continue` for text that starts with `/` (`multi-sub.ts:7622-7624`).

**Multi-pass loads first:**

1. Multi-pass's `input` handler may call `pi.setModel(allowed)` (`multi-sub.ts:7560`).
2. `model_select` fires while pi is idle. The guard's `model_select` handler runs, but `ctx.abort()` does nothing because no run is active (`agent-session.ts:2499-2501`).
3. The guard's `input` handler then sees the new `ctx.model` and can block with `handled` and offer its picker. This order works.
4. If multi-pass returns `handled` (no allowed provider), the guard never sees the prompt. That is harmless, because the prompt is not sent.

**Guard loads first:**

1. The guard sees the original model.
2. If the guard blocks, multi-pass never runs and nothing is sent.
3. If the guard allows (the model is in the guard's zone) but multi-pass's `allowedSubs` does not contain that provider, multi-pass then switches to its first allowed provider (`multi-sub.ts:2552-2561`, `multi-sub.ts:7554-7567`). The guard may not allow that provider.
4. The guard gets a `model_select` while pi is idle. An abort there is dropped (`agent-session.ts:2499-2501`). `_startRun` would also reset the flag (`agent-session.ts:1875`).
5. `prompt()` continues to `_startRun` on the switched account (`agent-session.ts:2153-2172`).

**Answer to the sub-question:** yes, the automatic switch in `enforceProjectRestriction` can produce a model change the guard must block. It runs before the guard's `input` handler only when multi-pass loads first. The safe design in both orders:

- Do not rely on `ctx.abort()` from `model_select` while idle.
- Re-validate `ctx.model` in `before_agent_start`. At that point the run is active, and an abort is honoured at `agent_start` (`agent-session.ts:1104-1106`, `agent-session.ts:1874`, `agent-session.ts:1935`).
- Alternatively, record a "re-check pending" flag in `model_select` and act on it in `before_agent_start`.

Which pi hooks can stop a send is the subject of the separate hook-gating research ticket. The behaviour cited here only comes from the code comment and flag logic above.

**Nested `model_select` order:** this concerns the guard's `model_select` handler during a run. Suppose multi-pass loads first and its `model_select` handler switches the model:

1. The outer emission carries `event.model = X`, the model multi-pass rejected.
2. Multi-pass calls `setModel(Y)` inside its handler (`multi-sub.ts:7618`, `multi-sub.ts:7560`). That emits a nested `model_select(Y)` to all handlers. The guard sees Y first.
3. When the outer emission resumes, the guard sees `event.model = X` while `ctx.model` is already Y (`agent-session.ts:3497`).

The guard should therefore evaluate `ctx.model`, not `event.model`. Otherwise it can abort because of a model that is no longer active.

**Commands bypass `input`:** extension commands (`/subs switch`, `/subs model`, `/mp-preset …`) and the multi-pass `/model` intercept never reach any `input` handler (`agent-session.ts:2101-2108`, `multi-sub.ts:7400-7455`). The guard sees those changes only through `model_select`, and then a later `input` or `before_agent_start` check.

**Replays reach `input`:** multi-pass's follow-up replay arrives in the guard's `input` handler with `source: "extension"` (`agent-session.ts:2457`). The guard can and should apply the same zone check to it.

## 4. Does multi-pass's own guard fail open?

**Verdict:** Yes, in every case the question names except "no allowed provider". With no project file, a malformed file, an `allowedSubs` that is the wrong type or empty, or pi started from a subdirectory, there is no restriction at all. When no allowed provider is usable, it fails closed, but only for typed, non-`/` input. Model changes and session start are never blocked; they only produce a warning.

- **Missing file:** `loadProjectConfig` returns `undefined` when the file does not exist (`multi-sub.ts:2413-2415`). `loadEffectiveConfig` then returns no `allowedProviderNames` (`multi-sub.ts:2461-2467`). `enforceProjectRestriction` returns `true` when the summary is empty (`multi-sub.ts:7546-7549`, `multi-sub.ts:2604-2608`).
- **Malformed JSON:** the parse error is caught and `undefined` is returned (`multi-sub.ts:2416-2419`), so the result is the same as a missing file, with no warning.
- **Wrong type or empty `allowedSubs`:** non-arrays are dropped (`multi-sub.ts:2398`). Empty arrays, and arrays whose entries are all blank, become `undefined` (`multi-sub.ts:2423-2426`). The result is unrestricted. README states "Omit to allow all" (`README.md:229`).
- **Subdirectory:** the path is exactly `join(cwd, ".pi", "multi-pass.json")`, with no upward search (`multi-sub.ts:2372-2374`). The `cwd` is `ctx.cwd` (`multi-sub.ts:7545`). Starting pi in `repo/sub/` ignores `repo/.pi/multi-pass.json`.
- **No usable allowed provider:**
  - Allowed names that are neither a multi-pass extra subscription nor a `SUPPORTED_PROVIDERS` base are never switch targets (`multi-sub.ts:2552-2561`). An example is a third-party provider such as `claude-bridge`; whether it is in `SUPPORTED_PROVIDERS` was not checked, so this is **unverified** for that specific id.
  - A provider without auth is skipped (`multi-sub.ts:2580`).
  - If nothing is found, it warns and returns `false` (`multi-sub.ts:7573-7578`).
  - Only the `input` handler acts on `false`, by returning `handled` (`multi-sub.ts:7626`). The `model_select` and `session_start` handlers ignore the result (`multi-sub.ts:7614`, `multi-sub.ts:7618`).
  - So a disallowed model selected by `/subs model`, `/mp-preset` or `/model` stays active, and the next typed prompt is blocked.
- **The current provider is allowed:** this passes even if multi-pass does not manage that provider (`multi-sub.ts:7550-7552`).
- **Text starting with `/`:** it is always passed through (`multi-sub.ts:7622-7624`). pi expands `/skill:…` and prompt templates into real prompts after the `input` handlers run (`agent-session.ts:2131-2134`). A skill or template invocation therefore reaches the model with no multi-pass input check. This is a real gap, not only a theoretical one. It is normally hidden because the model was already enforced at `model_select` and `session_start`.
- **Re-entrancy:** while its own switch is in flight, enforcement returns `true` without checking (`multi-sub.ts:7544`).
- **Outside multi-pass:** the HTTP clients of other extensions, and subagent child processes, are not covered. Nothing in `multi-sub.ts` hooks provider requests (`multi-sub.ts:7582-7700`).

## 5. Keeping rotation away from non-matching accounts without coupling

**Verdict:** No mechanism stops multi-pass's rotation from choosing an account without coupling to multi-pass. The guard can only react through `model_select`. Two complementary approaches work without an API dependency:

- Recommend config hygiene so rotation never has a non-matching candidate.
- Rely on the `model_select` abort, plus a `before_agent_start` re-check, as the enforcement backstop.

### Option A: users write a project `allowedSubs` that mirrors the zone

**What it gives:** multi-pass filters subscriptions, pools and chains to the allow-list (`multi-sub.ts:2470-2481`, `README.md:174`). The failover plan is built only from those pools (`multi-sub.ts:7672-7677`, `multi-sub.ts:3299-3441`), so rotation stays in-zone. `/subs switch` is filtered too (`multi-sub.ts:3863-3868`).

**What it costs:**

- **Two sources of truth.** The guard's zone rules and the per-repo `allowedSubs` can drift apart. When they disagree, see the picker-override case in question 2.
- **The file must exist in every directory pi starts from.** There is no upward search (`multi-sub.ts:2372-2374`), and the file is ignored without warning when malformed (`multi-sub.ts:2416-2419`).
- **Files in repositories.** The user must write `.pi/multi-pass.json` into each repository, including work repositories. Whether it should be committed or gitignored is the user's call.
- **Multi-pass switches automatically**, both on `input` and on `model_select` (`multi-sub.ts:7560`). This contradicts the guard's "never auto-switch" stance, even if the user asked for it.
- **Some paths ignore it.** Presets and `/subs model` are unfiltered (`multi-sub.ts:7055-7058`, `multi-sub.ts:3944`), and are only corrected afterwards by the automatic switch.
- **Upside:** it reduces how often the guard's abort fires, because rotation rarely lands outside the zone.

### Option B: zone-pure pools and chains, as a documentation rule only

**What it gives:** recommend that every global pool contains accounts from a single zone, and that every chain only links pools of the same zone. Failover only picks members of the current pool and later chain entries (`multi-sub.ts:3299-3441`). Under this rule, a rotation that starts from a matching account stays matching.

**What it costs:**

- It depends on user discipline, and the guard cannot check it without reading multi-pass config, which would be coupling.
- A pool may legitimately need to mix zones, for example a shared "codex" pool.
- Chains can cross pools (`multi-sub.ts:3361-3392`), so the user must audit chains as well.

### Option C: rely on the `model_select` abort, with `before_agent_start` as backstop

**What it gives:**

- Every multi-pass model change goes through `session.setModel` and therefore emits `model_select` (`agent-session.ts:3488-3492`, `agent-session.ts:2560`).
- A rotation during a run is aborted before pi's retry or continuation (`agent-session.ts:1982-1985`).
- Idle-time switches (`/subs`, presets, `/model` intercept, session start, multi-pass's input switch) are caught by the next `input` check or the `before_agent_start` re-check.
- No configuration is duplicated, and there is no API coupling.

**What it costs:**

- **The turn that hit the rate limit is lost.** The user sees an aborted turn instead of a failover.
- **The model stays on the rejected account** until the user picks another one.
- **Retries and replays are cancelled.** pi's auto-retry is cancelled. A multi-pass follow-up replay may stay queued (**unverified**), and the guard must block it at `input` (`source: "extension"`).
- **Multi-pass bookkeeping goes stale.** The exhausted mark, the attempted set and `suppressNextStartTurn` no longer match what happened (`multi-sub.ts:3714`, `multi-sub.ts:3777`, `multi-sub.ts:3793`).
- **Notices contradict each other.** Multi-pass reports a successful transition (`multi-sub.ts:3782-3790`) right before the guard's abort notice.
- **There is a picker cost per rate limit:** one aborted turn per rate limit in a mixed pool.
- **Every `model_select` must be handled correctly:** use `ctx.model`, not `event.model`, and handle idle-time changes with a deferred check.

### Option D: rejected, because it needs coupling

These options would control rotation directly, but each one couples the guard to multi-pass:

- reading multi-pass config to pre-filter candidates
- calling multi-pass commands
- rewriting `allowedSubs` from the guard

All of them conflict with the "independent of multi-pass" decision.

**Recommendation:** use Option C as the enforcement mechanism. Document Options A and B as optional ways to reduce friction. Never require either of them for correctness.

## Implications for pi-account-guard

### Recommended coexistence rules

1. **The guard is authoritative; multi-pass is advisory.** Treat every model change as untrusted, whatever its source. Never read or write multi-pass config or state.
2. **Never switch models automatically.** Only a user choice in the picker calls `pi.setModel`. Multi-pass's `model_select` enforcement already switches automatically (`multi-sub.ts:7617-7619`). If both did, they could alternate. With only one automatic switcher, the exchange ends after one step.
3. **Check at three points:**
   - `input`, for every `source`, including `"extension"` replays (`agent-session.ts:2457`).
   - `model_select`, but call `ctx.abort()` only when a run is active. Otherwise set a "re-check pending" flag.
   - `before_agent_start`, unconditionally or when the flag is set, calling `ctx.abort()` on a mismatch (`agent-session.ts:1104-1106`).

   This makes the guard correct whatever the load order (question 3).
4. **Evaluate `ctx.model`, not `event.model`**, in `model_select`. Nested emissions from multi-pass's handler make `event.model` stale (`multi-sub.ts:7618`, `multi-sub.ts:7560`, `agent-session.ts:3497`).
5. **Do not skip text that starts with `/`** the way multi-pass does. Skills and templates expand after `input` (`agent-session.ts:2131-2134`). Extension commands never reach `input` (`agent-session.ts:2101-2108`), so the guard does not need to special-case them there.
6. **Fail closed** where multi-pass fails open. A missing or malformed guard config, or an unresolvable place, must not mean "allow" (contrast `multi-sub.ts:2413-2419`, `multi-sub.ts:7546-7549`). Resolve the place by its own rules, not only from `ctx.cwd/.pi` (contrast `multi-sub.ts:2372-2374`).
7. **Say what happened in the abort notice.** When aborting right after a rotation, name the rejected account and say that the failover was blocked. Multi-pass will just have posted a "switched to" notice (`multi-sub.ts:3782-3790`).
8. **Expect the picker to be overridden** when the user picks an account outside multi-pass's `allowedSubs`. The guard should detect the second `model_select` and explain it, for example "multi-pass project restriction switched to X", instead of re-opening the picker in a loop.
9. **Document optional hygiene** for users:
   - Keep pools and chains zone-pure.
   - Optionally mirror zones in `.pi/multi-pass.json`, knowing it fails open and switches automatically.

### Facts the design must cite

- **`pi.setModel` emits `model_select`, which cannot be vetoed.** `pi.setModel` → `session.setModel` → `model_select`, with no cancel and errors swallowed: `agent-session.ts:3488-3492`, `agent-session.ts:2541-2561`, `runner.ts:1096-1125`.
- **An abort only works on an active run, and an active abort cancels the retry.** `agent-session.ts:2498-2502`, `agent-session.ts:1874-1875`, `agent-session.ts:1982-1985`.
- **An abort during `before_agent_start` stops the run.** `agent-session.ts:1104-1106`, `agent-session.ts:1935`.
- **`input` chain semantics and load-order dependence:** first `handled` wins, `transform` chains, and handlers run in extension array order. `runner.ts:1524-1564`, `runner.ts:276-277`.
- **Extension commands bypass `input`; skills and templates expand after it.** `agent-session.ts:2101-2108`, `agent-session.ts:2131-2134`.
- **`sendUserMessage` replays reach `input` as `source: "extension"`, and are queued while streaming.** `agent-session.ts:2429-2458`, `agent-session.ts:2136-2149`, `agent-session.ts:1479-1481`.
- **Multi-pass switch sites:**
  - `multi-sub.ts:7560` (restriction, on `session_start`, `model_select` and `input`)
  - `multi-sub.ts:3765` (failover, in `agent_end`)
  - `multi-sub.ts:7092` (presets, unfiltered)
  - `multi-sub.ts:4183` (`/subs switch`, filtered)
  - `multi-sub.ts:3989` and `multi-sub.ts:4123` (`/subs model` and the `/model` intercept, unfiltered)
- **Replay condition.** Multi-pass re-sends only when pi will not retry: `multi-sub.ts:3792-3797`, `multi-sub.ts:2920-2933`.
- **Rotation is bounded.** It is forward-only within a turn and uses a 5-minute exhausted cooldown: `multi-sub.ts:3299-3441`, `multi-sub.ts:3714`, `multi-sub.ts:3209`, `multi-sub.ts:3777-3780`.
- **Multi-pass fails open.** `multi-sub.ts:2372-2374`, `multi-sub.ts:2398`, `multi-sub.ts:2413-2426`, `multi-sub.ts:7546-7552`, `multi-sub.ts:7614`, `multi-sub.ts:7618`, `multi-sub.ts:7622-7626`.

### Open points (unverified)

- Whether pi-agent-core awaits async `agent_end` listeners before pi decides on a retry. Multi-pass assumes it does.
- What happens to a follow-up queued during a run that is then aborted: delivered with the next prompt, cleared, or restored to the editor.
- Which interactive or RPC modes install `_extensionAbortHandler` (`agent-session.ts:3503-3505`), and what it does differently from `abort()`.
- The exact contents of `SUPPORTED_PROVIDERS`, which decides which `allowedSubs` names multi-pass can switch to.
