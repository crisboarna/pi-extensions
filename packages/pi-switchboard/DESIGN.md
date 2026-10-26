# pi-switchboard design

Status: **approved 2026-10-25**; built 2026-10-26 (see section 19 for changes made during the build and what was verified). Terms in bold are defined in [GLOSSARY.md](GLOSSARY.md); the three hardest decisions have ADRs in [docs/adr/](docs/adr/).

## Summary

pi-switchboard is a pi package that picks a model for every piece of agent work. A decision classifier answers a small set of typed questions about the work. Deterministic rules turn the answers into a **tier**. The active **profile** maps the tier to one or more **members**, and a **strategy** picks one member. The same engine runs in the main session (as a virtual model, `switchboard/auto`) and inside pi-subagents children. Every **decision** is recorded with its **evidence**, answers, confidence and the model that ran, and an offline **inspector** shows the whole flow with cost.

The source contains no provider or model IDs. Profiles, tiers and members live only in user config and in `examples/`.

```text
            ┌──────────── evidence (bounded, redacted) ────────────┐
user turn ─▶│ request · plan phase · tool outcomes · agent · edits │
            └───────────────────────────┬──────────────────────────┘
                                        ▼
                    classifier chain (one call, all questions)
                                        ▼
         answers ─▶ ruleset: tier rules (first match) + floor rules (all)
                                        ▼
            gating confidence ≥ threshold ?  no ─▶ fallback tier
                                        ▼
                   pin · hysteresis · escalation · context fit
                                        ▼
       tier ─▶ strategy + modifiers (health, cooldown, affinity) ─▶ member
                                        ▼
                route() returns { model, thinkingLevel, state }
                                        ▼
            decision entry · footer · debug log · usage ledger
```

## 1. Goals and non-goals

Goals:

- Route the main session and pi-subagents children by complexity, with one engine and one config.
- Support any number of profiles, tiers (with explicit **ranks**) and members across providers and accounts, with no code changes.
- Follow the Jev engineering rules: the classifier decides, it never writes; evidence goes in, not summaries; one batched call per decision; act only on confident answers; code acts deterministically; the classifier's answer is final.
- Make every decision explainable after the fact: footer, TUI entry, `/tier explain`, the inspector, replay and a cost report.
- Protect the prompt cache: switch models only on purpose, and count and log every switch.

Non-goals (v1):

- Workflow-script children (`runs.run`, `runs.all`). They do not pass through the `subagent` tool.
- Changing pi-subagents, pi-multi-pass or pi-powerline-footer. Upstream issues instead.
- Training or calibrating a classifier beyond a threshold and an optional temperature.
- A live web server for the inspector.

## 2. Prior art and why a new package

All 13 packages named in the spec exist on npm; their source was read (versions as of 2026-10-24). None routes both the main session and pi-subagents children with per-member health.

| Package | Scope | Mechanism | What we take | What we do differently |
|---|---|---|---|---|
| pi-tier-router 0.3.1 | main | virtual model `router/auto`; decision in `before_agent_start` held in a module global | layered classification idea | decide inside `route()` on `reason: "user"`, no module globals |
| pi-gearshift 0.2.0 | main | Jev, then `pi.setModel` per turn | per-turn tiering | no `setModel` (no fight with multi-pass), no 5 s blocking default |
| @alexeiled/pi-model-router 0.16.0 | main | custom provider `router` with `streamSimple`; classifier advisor; escalation after repeated tool failures; restricted project config | escalation trigger, fail over only before output, restricted project config | virtual model instead of provider; covers subagents; per-member health |
| @each1024/pi-jev-route 1.0.8 | subagents | `tool_call` rewrites `input.model` | the launch-time injection pattern (our fallback mode) | child-side routing keeps failover inside the child |
| pi-bifrost 0.5.0 | main | `setModel` or `bifrost/auto`; rules, cache, classifier; circuit breaker 3 fails/5 min, 60 min open, half-open trial with doubling | named tiers with several members, half-open trials | Retry-After honoured, locked atomic state shared across processes |
| pi-multiprovider 0.11.3 | main + children | virtual providers over native `streamSimple`; per-class cooldowns; 3 pre-output errors absorbed | per-class cooldowns, `allowedFails` | health shared through a locked file, not memory only |
| pi-model-auto-router 0.4.0 | main | custom provider; least-loaded, round robin, cache-first; SQLite cooldowns | failure classes, stall watchdog idea | no SQLite dependency |
| pi-rotator 0.5.2 | main | `setModel` across account aliases; fixed 6 h cooldown; stands by when another router is present | coexistence check | reset times from errors, not fixed |
| pi-chatgpt-pool 0.2.3 | main | virtual model plus per-account providers; rewrites the error in `message_end` so pi's retry re-enters `route()`; parses Retry-After and `resets_at` | **the `message_end` rewrite** (section 4.6) and reset parsing | generic across providers, explicit opt-in |
| pi-weighted-model-router 0.5.9 | main | weighted pick at session start, fallback on 400/429/5xx | smooth weighting | documented lack of lock and atomic write avoided |
| pi-provider-manager 1.1.2 | n/a | CLI for `models.json` | atomic write, PID-liveness lock | same pattern for `health.json` |
| oh-my-subscriptions 0.33.1 | accounts | loopback sidecar; earliest quota reset; stale usage treated as unknown | `soonest-reset`, unknown-when-stale | no sidecar process |
| pi-router 0.5.9 | main | custom provider `router/auto`; circuit after 5 fails, single-flight probe | single-flight half-open probe | own provider id |
| pi-dynamic-workflows 3.14.0 | its own workflow workers | script author tags `agent()` calls with `small`/`medium`/`big`; one model per tier; usage limits pause the run and auto-resume | live `/workflows` navigator and progress widget, interactive tier editor, price-ranked auto-tiering, budgets, resume after usage limits (all rebuilt here, 11.5 to 11.7, 7.7, 9.6, 9.7) | a classifier picks the tier, several members per tier, covers the main session and pi-subagents; no integration with its runtime |

LiteLLM routing: per-deployment cooldown with `allowed_fails` (default 3) and a short `cooldown_time`, immediate cooldown on 429, per-error `allowed_fails_policy`. We adopt per-class `allowedFails`.

Pitfalls the survey documents, and how this design avoids them:

- **Provider id collisions** (`router/auto` is used by four packages and pi's own example): the virtual model lives under `switchboard`, configurable.
- **Two extensions calling `pi.setModel`** for one failure: pi-switchboard never calls `setModel` (ADR-0002).
- **Children cannot be identified by a provider**: routing runs inside the child through required child extensions (ADR-0001).
- **Module globals and unlocked writes** race across sessions: state is per session (router state) or in a locked, atomically written file.
- **Fixed long cooldowns, Retry-After ignored**: durations come from the error first.
- **Stacked retry layers**: pi's `retry.provider.maxRetries` stays 0 (pi's default); pi's agent-level retry is the only retry loop, and pi-switchboard only chooses the target.
- **Classifiers sending user text to a third party**: remote classifiers need `allowRemote`.
- **A repository's `.pi/*.json` as a trust boundary**: the project file cannot change classifiers or load modules.

Why a new package: the gap the spec names (routing pi-subagents children) is unfilled, and no package combines classifier tiers, several members per tier with health, and an offline audit trail. The full survey is in the session scratchpad report `prior-art.md`.

## 3. Architecture

### Modules

| Module | Responsibility | Pure? |
|---|---|---|
| `config/` | Load user and project config, merge, validate against the JSON Schema and the model registry, report per-profile errors | mostly |
| `classifier/` | Register System One classifier providers (LM Studio and similar), run the **classifier chain** with timeouts, build and redact evidence | no |
| `rules/` | Evaluate tier rules and floor rules, resolve **tier targets** (`@top`, `@middle`, `@bottom`), compute **gating confidence** | yes |
| `profiles/` | Choose the active profile from manual, project, match and default sources | yes |
| `tiering/` | Apply pin, hysteresis, escalation, fallback, baseline, direct and context-fit rules to produce the final tier | yes |
| `selection/` | Strategies, modifiers, error classification, health store, shared state file and lock, **usage ledger**, metric providers | mostly |
| `router/` | The virtual model's `route()`: glue between the request, tiering, selection and recording | no |
| `subagents/` | `tool_call` hook for the `subagent` tool, launch decisions, required-child-extension registration, child runtime that reads bindings | no |
| `record/` | Decision entries, entry renderer, footer status, debug log | no |
| `commands/` | `/tier …` commands | no |
| `timeline/` | Parse session JSONL into tasks, requests, tool calls, decisions and subagent links; shared by replay, inspector and report | yes |
| `live/` | Child status files and transcript mirrors, retention sweep, the live model the navigator reads | no |
| `tui/` | Navigator overlay, running-work widget, tier editor, entry renderer | no |
| `autotier/` | Rank signed-in models and propose profiles for `/tier init` | yes |
| `budgets/` | Track task and session spend against soft budgets | yes |
| `cli/` | `pi-switchboard replay \| inspect \| report` | no |

Pure modules take a clock, a random source and plain data, so they are tested without pi.

### Runtime hooks

| pi hook | Use |
|---|---|
| `pi.registerVirtualModel` | `switchboard/auto`, `switchboard/<profile>`, `switchboard/<profile>.<tier>` (4.5), registered in the factory |
| `pi.registerProvider` | System One classifier providers from `classifierProviders` |
| `session_start` | Load config, restore control entries (pin, dry-run, manual profile), publish status |
| `model_select` | Track the **origin model** (the physical model selected before the virtual one), detect leaving or re-entering routing |
| `before_agent_start` | Start a **task**: query Plannotator's phase, reset per-turn counters |
| `tool_call` (`subagent`) | Classify launches and set model or bindings |
| `message_end` | Usage ledger, latency samples, quota-error rewrite (4.4) |
| `tool_result` (`subagent`) | Link launch decisions to child runs, release launch-mode leases |
| `session_shutdown` | Dispose the required-child-extension registration, release leases, mark the child's live status ended |
| `message_end`, `tool_call`, `tool_result`, `turn_end` (in children) | Write the child's live status and transcript mirror (11.6) |
| `pi.registerShortcut` | Navigator shortcut (default `ctrl+alt+w`) |
| `ctx.ui.custom` / `ctx.ui.setWidget` | Navigator overlay, tier editor, running-work widget |
| `pi.events` | Plannotator `plannotator:request`, pi-usage `usage:query:v1` when present |
| `pi.appendEntry` / `pi.registerEntryRenderer` | Decision and control entries, collapsed TUI rendering |
| `ctx.ui.setStatus` | Footer keys `tier` and `tier-sub` |
| `pi.registerCommand` | `/tier` |

## 4. Main-session routing

The virtual model is registered under its own provider id (default `switchboard/auto`), never under a physical provider. This keeps pi-multi-pass inert while routing (see ADR-0002) and avoids hiding a physical model of the same id.

### Per request reason

| `request.reason` | Behaviour |
|---|---|
| `user` | Start of a task. If pinned: use the pinned tier, no classification. If dry-run: classify, record, route to the **baseline tier**. Otherwise classify once with all questions, apply rules, gating, floors and hysteresis, then run the tier's strategy. Return the result with new router state. |
| `continuation` | Return `previous` (cache-safe). Exception: an escalation trigger fires (section 4.2) and this task has not escalated yet; then move up one rank, select a member, record an `escalated` decision. |
| `retry` | Classify the error of `failed.message` (section 9.3). Rate limit, quota or auth: bench the member and select the next healthy member of the same tier (or an **account sibling** first, when enabled). Overload or capacity: keep `failed` without benching, switch only after `overloadSwitchAfter` consecutive overloads. Context overflow: keep `failed` (pi compacts first). Anything else: keep `failed`. The tier never changes on retry. |
| `direct` | The profile's **direct tier** (default: lowest rank). Walk up ranks until a member's context window fits the conversation; if none fits, use the latest physical model. No router state is available or stored. |

pi removes a failed assistant message from context, and its tool calls never ran (`stopReason: "error"`), so switching on retry cannot repeat side effects. pi-switchboard never replays a prompt itself: it never calls `sendUserMessage`.

### 4.1 From answers to a tier

1. **Signals** are facts that need no classifier: `$planMode` (Plannotator phase), `$scope` (`main` or `subagent`), `$agent` (subagent name). Rules can test them with confidence 1.
2. **Tier rules** are evaluated in order; the first whose `when` matches wins. Its **gating confidence** is the minimum confidence of the choice and bool answers that rule references (signals count as 1). Choice confidence is the server's value, the top probability rescaled so an even split is 0 and certainty is 1: `(n·p_top − 1)/(n − 1)` for `n` options. Bool confidence uses the same scale, `|2p − 1|`, so one threshold means the same everywhere (at 0.80: a 5-option choice needs `p_top ≥ 0.84`, a yes/no answer `p ≥ 0.90` or `≤ 0.10`). Score answers never gate: a rule tests a score by its expected value (for example `depth < 1.0`), because decision models report low score confidence even when the value is clearly placed (measured in 8.5). Score confidence is still recorded. The default rule has no gate.
3. If the gate fails, the candidate is the **fallback tier**, and the decision records `fallback:low-confidence`. The threshold is the profile's `threshold` when set, else the `threshold` of the classifier that answered, else `classification.threshold` (0.85), because calibration differs per classifier.
4. **Floor rules** are evaluated independently; every floor whose own gating confidence passes raises the candidate to at least its target.
5. **Hysteresis**: a candidate above the current tier is taken at once. A candidate below it counts a down vote; the tier drops only after `downTurns` (default 2) consecutive down votes. An unconfident decision may raise the tier to the fallback tier but never lowers it and never counts as a down vote.
6. The **pin**, when set, replaces steps 1 to 5.

Tier targets: a rule names a tier of the profile or a rank keyword. `@top` is the highest rank, `@bottom` the lowest, `@middle` the upper median by rank index (with tiers sorted by rank ascending, index `floor(n/2)`). One tier: all keywords resolve to it.

### 4.2 Escalation

Computed from `request.messages` since the last user message, so it needs no extra state and survives reloads:

| Trigger | Default |
|---|---|
| The same tool name returned an error N times in this task | N = 2 |
| Tool errors of any name in this task | 3 |
| Escalations per task | at most 1 |

Escalation moves up one rank (not to `@top`) and ends with the task: the next user turn classifies afresh, and hysteresis counts from the escalated tier. In children, escalation is capped by the agent's `maxTier`.

### 4.3 Thinking level

The thinking level the user selects on the virtual model (Shift+Tab) is an **offset** on the member's configured level: `low` is one step down, `medium` (the default) is as configured, `high` is one step up and `xhigh` is two steps up, on the scale `off, minimal, low, medium, high, xhigh`. A member without `thinking` counts as `medium`, so it runs at exactly the selected level. pi clamps the result to what the routed model supports. Subagent launches carry the parent's selected level in the model suffix, so the offset applies in children too.

### 4.4 Quota errors reach `route()` through an error rewrite

pi's automatic retry skips errors it considers non-retryable, which include quota and usage-limit errors (`insufficient_quota`, `quota exceeded`, `billing`, `subscription_sharing_usage_limit_exceeded` in `pi-ai/dist/utils/retry.js`). Without help, `route()` would never see them. A `message_end` handler therefore replaces the error text of a failed assistant message with a retryable one (`pi-switchboard: <model> hit its usage limit; retrying on another member`), so pi's retry re-enters `route()` with `reason: "retry"`. It does this only while routing, only for errors classed `quota` or `auth`, and only when the tier has another healthy member. The original text is kept in the decision entry and the inspector. pi-chatgpt-pool uses the same technique.

### 4.5 Virtual models

All virtual models are registered in the extension factory, from config loaded synchronously, because children resolve their model before `session_start`:

| Model | Meaning |
|---|---|
| `switchboard/auto` | profile from the selection rules (7.3) |
| `switchboard/<profile>` | that profile; selecting it counts as a manual-session profile |
| `switchboard/<profile>.<tier>` | that profile, pinned to that tier; used for subagent launches (5.2) |

Profile and tier names must match `[a-z0-9][a-z0-9-]*`. `/reload` re-registers them after a config change.

### 4.6 Leaving and re-entering routing

A `model_select` to a physical model with source `set` or `cycle` ends routing: the footer shows `switchboard off`, and the selected physical model is remembered as the origin model. Selecting the virtual model again resumes routing with the session's last router state. A `restore` (session resume) to the virtual model resumes silently.

### 4.7 No usable profile

When no config exists, or every profile is invalid, the virtual model stays registered (so a saved default model does not break startup), the footer says `switchboard inactive: <reason>`, and `route()` returns the origin model (or the latest physical model) and records an `inactive` decision. If neither exists, `route()` throws an error that names the fix (`/tier init`).

## 5. Subagents

Decision recorded in ADR-0001: child-side virtual model, with a launch-time physical model as fallback.

### 5.1 Facts this design rests on

Verified in pi-subagents source (paths under its package root):

- A parent `tool_call` hook runs after pi validated the arguments and before pi-subagents normalizes them, and mutations are not re-validated by pi, so setting `model` on the call or on each task works (`pi-agent-core/dist/agent-loop.js:491`, `src/extension/index.js:638`).
- Local foreground children never load the parent's ambient extensions and never receive `options.extensionBindings`: the `PI_SUBAGENT_EXTENSION_BINDINGS` variable is only set for background runner children (`src/runs/shared/child-launch.js:225`). Default parallel launches (`workflow: "parallel"`) accept a model per task but no binding per task.
- `registerRequiredChildExtensions({ sessionId, extensions: [{ id, path }] })` from `pi-subagents/required-child-extensions` loads an extension into native foreground, background, nested and recovered children. One registration per parent session; a second throws. Virtual models registered in the extension factory resolve before the child's model is resolved (`src/runs/shared/child-session.js:266-289`); registering them in `session_start` is too late.
- The child run ID is generated when the tool executes, so it is unknown at `tool_call`. The tool result's `details.results[i]` carries `runId`, `model` and `sessionFile`, and each child session header records `parentSession`.
- Upstream: pi-subagents PR [#3049](https://github.com/nicobailon/pi-subagents/pull/3049), merged 2026-10-25 (`7fe94c3f`), restores `extensionBindings` for foreground children; it ships in the first release after 0.82.1. Routing does not depend on it; exact child linking (5.7) uses it.
- There is no public API that says whether an agent's model is pinned by frontmatter, `agentOverrides` or `subagents.defaultModel`. `resolveSubagentLaunchContract` from `pi-subagents/preflight` returns the resolved model without a parent model; an undefined model means nothing pins it.

### 5.2 Launch tier reaches the child through a tier-pinned model

pi-switchboard registers, next to `switchboard/auto` and one `switchboard/<profile>` per valid profile, a **tier-pinned model** `switchboard/<profile>.<tier>` for every tier of every valid profile. The parent writes one of these into each task's `model` field. The child's `route()` reads the profile and tier from `request.model.id`, so no environment variable or binding is needed, and foreground, background and parallel children all work the same way. Selecting a tier-pinned model in the main session means "this profile, pinned to this tier".

### 5.3 Parent: launch flow (`tool_call` on `subagent`)

1. Find the tasks: a single launch (`agent`, `task`, top-level `model`); a parallel workflow (`workflow: "parallel"`, `args.tasks[i]`); and, when workflow scripts are disabled, top-level `tasks[i]` and structured chain steps (`chain[i]` and `chain[i].parallel[j]`, each with an optional `model`). A chain step whose task uses `{previous}` is classified on its template text, since the previous output does not exist yet. Management actions are ignored.
2. Skip a task, recording why, when: subagent routing is off; the agent is in `subagents.exclude`; the call or task already names a model; or the preflight contract resolves a model that is not a switchboard virtual model (frontmatter, `agentOverrides` or `defaultModel` pins it). When preflight is unavailable or fails, the task is treated as pinned: an explicit choice is never overridden on a guess.
3. Classify all routable tasks of the call concurrently, one classify call per task, with evidence `scope: "subagent"`, the agent name and tools from the contract, the bounded task text and the parent's plan phase.
4. Pick the tier: rules and floors as in 4.1, then the agent's `fixedTier`, `minTier` and `maxTier`, then `/tier pin --subagents` if set. Hysteresis does not apply to launches.
5. Pick the profile: `subagents.profile`, else the parent's active profile.
6. Write the model:
   - **child mode** (default): `switchboard/<profile>.<tier>:<parent thinking level>`.
   - **launch mode** (fallback): select a physical member now with the tier's strategy, take an in-flight lease in the shared state, apply `accountAffinity`, and write `provider/id:thinking`.
7. Append one decision entry per task (`reason: "launch"`) with the `toolCallId` and task index.
8. On `tool_result` for that call, append a `pi-switchboard.link` entry mapping each decision to `runId`, `sessionFile` and the model that ran, and release launch-mode leases.

Launch mode is used when `subagents.mode` is `"launch"`, when pi-switchboard could not register as a required child extension, or for an agent that resolves to an external runner.

### 5.4 Child: routing inside the subagent

- The parent registers pi-switchboard's entry file as a required child extension at `session_start` and disposes it at `session_shutdown`. If the slot is taken, it warns once and uses launch mode for that session.
- The child loads config synchronously in the extension factory and registers the same virtual models, so `switchboard/<profile>.<tier>` resolves before the child's model is chosen.
- The child does not classify. On `user` it starts at the launch tier; `continuation`, `retry`, escalation and `direct` behave as in section 4. Escalation is capped by the agent's `maxTier`.
- The child records its own `failover`, `escalated` and `direct` decisions in its session. The inspector joins them to the parent's launch decision through the link entry and the child header's `parentSession`.
- Parallel children share round-robin pointers, in-flight leases and cooldowns through the locked health file (9.4).
- Nested subagents work the same way: the child's own `tool_call` hook classifies its launches.

### 5.5 Account affinity

`accountAffinity: "parent"` maps a member such as `openai-codex/x` onto the account the parent last used for that base provider (for example `openai-codex-2/x`) when that model exists and has credentials. In launch mode the parent applies it directly. In child mode the parent writes its last account per base provider into the health file, keyed by its session file, and the child reads it through its header's `parentSession`. `"none"` uses members exactly as configured.

### 5.7 Exact child linking through bindings

The parent adds a `pi-switchboard/1` entry to the call's `options.extensionBindings` (next to any bindings other extensions set): its session, and for each routed task the agent, a digest of agent and task text, and the launch decision id. One binding covers all tasks of a parallel call, so launches are keyed by digest. The child reads the binding while its extensions load and at `session_start` (foreground children see it only then), matches its first message by digest (else the only launch of its agent, else the only launch), and stamps `launchDecisionId` on its own decisions and its live status. The navigator and inspector then join children to launch decisions exactly instead of by agent and start time.

The binding is attached only when every task of the call runs natively: pi-subagents rejects bindings for external runners. Background children have received bindings in every pi-subagents version; foreground children receive them from the first release after 0.82.1. Without a binding, joining falls back to agent and start time.

### 5.6 Not covered

- Workflow scripts (`workflow: true` or a script file) and their `runs.run` or `runs.all` children, including chains written as scripts: the script text is read from the assistant message or a file, so a hook cannot edit it. A child-side `switchboard/child` model that classifies its own task was considered and rejected (decision 42).
- Agents with an external runner (`runner.type` in their frontmatter, such as `external-cli`): they are never routed, because they cannot use pi models, and a call that includes one gets no binding.

## 6. Interaction with pi-multi-pass

Decision recorded in ADR-0002: pi-switchboard owns failover while its virtual model is selected.

Verified facts (from `pi-multi-pass/extensions/multi-sub.ts`):

- multi-pass rotates on `agent_end` when the last assistant message has `stopReason: "error"` and the error matches `usage.?limit`, `rate.?limit`, `limit.*reached`, `too many requests`, `overloaded`, `capacity`, `429` or `quota` (`RATE_LIMIT_PATTERNS`, line 2893).
- It looks up a pool by `ctx.model.provider` (`getPoolForProvider`, line 3707). While `switchboard/auto` is selected, that provider is `switchboard`, which is in no pool, so `handleError` returns false and multi-pass does nothing.
- When it does rotate, it marks the member exhausted for 5 minutes (line 3209), calls `pi.setModel`, and either waits for pi's own retry or re-sends the last prompt as a follow-up when pi will not retry (line 3792).

Consequences for pi-switchboard:

- Account siblings are read from `~/.pi/agent/multi-pass.json` (`subscriptions: [{ provider, index, label }]`, providers named `<provider>-<index>`) and the `MULTI_SUB` environment variable, the same way the existing `subscription-status.ts` extension does. pi-switchboard never writes that file.
- `accountSiblings: "off"` (default) never crosses accounts. `"on"` tries siblings of the failed member before the next member, after a one-time terms-of-service warning stored in `state.json`.
- A project `.pi/multi-pass.json` with a non-empty `allowedSubs` makes multi-pass switch away from any model whose provider is not listed, which includes `switchboard`. `/tier validate` warns when it finds one and suggests adding `switchboard` to that list.
- Account pooling **as a strategy** (listing several accounts of one provider as members of one tier) is allowed but is flagged by validation with the same one-time warning.

## 7. Configuration

Files:

| File | Scope | May set |
|---|---|---|
| `~/.pi/agent/pi-switchboard.json` | user | everything |
| `<project>/.pi/pi-switchboard.json` | project | `profile`, `profiles` (add or adjust), `rulesets`, `profileSelection.rules` (prepended), `subagents.agents` |
| `~/.pi/agent/pi-switchboard/state.json` | extension-owned | global manual profile, one-time warnings shown |

pi-switchboard rewrites a config file only from `/tier init` and the tier editor (11.7), and only after showing a diff and getting confirmation; it writes a timestamped `.bak` first and saves formatted JSON with stable key order. Runtime choices such as the global manual profile stay in `state.json`.

The project file can never change classifiers, classifier providers, evidence limits, debug or state settings. A JSON Schema ships as `schema/pi-switchboard.schema.json`; `/tier init` writes `"$schema"` into the starter file.

### 7.1 Schema outline

```jsonc
{
  "$schema": "…/pi-switchboard.schema.json",
  "version": 1,
  "virtualModel": { "provider": "switchboard", "id": "auto", "name": "Switchboard" },

  // Registers local classifier servers (8.4): LM Studio, llama-server, a vLLM/SGLang/MLX shim, ...
  "classifierProviders": [
    { "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1/", "api": "system-one",
      "models": ["<decision-model-id>"] }
  ],
  // Tried in order within one decision. Non-local entries need allowRemote.
  "classifiers": [
    { "model": "lmstudio/<decision-model-id>", "timeoutMs": 2000, "threshold": 0.8,
      "warmup": true, "keepWarmMs": null },
    { "model": "<provider>/<model>", "timeoutMs": 2000, "allowRemote": true }
  ],
  "classification": {
    "threshold": 0.85,                 // used when neither the profile nor the classifier sets one
    "decisionBudgetMs": 4000,
    "temperature": null,
    "questions": "builtin",            // or a map of custom questions
    "evidence": { "maxTokens": 4000, "requestTokens": 2500,
                  "toolErrors": { "max": 5, "chars": 200 }, "redact": [] }
  },

  "rulesets": {
    "quality-first": {
      "tierRules": [
        { "when": { "$planMode": "planning" }, "tier": "@top" },
        { "when": { "work": ["plan", "review"] }, "tier": "@top" },
        { "when": { "work": "mechanical", "depth": "<0.5" }, "tier": "@bottom" },
        { "tier": "@middle" }
      ],
      "floorRules": [ { "when": { "risky": true }, "atLeast": "@middle" } ]
    }
  },

  "profiles": {
    "<name>": {
      "description": "…",
      "projects": ["~/work/**"],          // optional: only valid here
      "ruleset": "builtin",               // name, or an inline { tierRules, floorRules }
      "threshold": 0.85,                  // optional override
      "strategy": "sticky",               // default for tiers that set none
      "tiers": {
        "<tier>": {
          "rank": 3,
          "strategy": { "name": "round-robin", "granularity": "session" },
          "affinity": { "scope": "session", "ttlMs": null },
          "cooldown": { "scope": "member", "defaultMs": 300000 },
          "members": [
            { "model": "<provider>/<model>", "thinking": "high",
              "weight": 1, "enabled": true, "maxConcurrency": 4,
              "schedule": [{ "days": "mon-fri", "from": "09:00", "to": "18:00" }],
              "budget": { "window": "5h", "tokens": 2000000 }, "tags": ["sub"] },
            "<provider>/<model>:medium"     // shorthand
          ]
        }
      },
      "fallbackTier": "<tier>",
      "baselineTier": "<tier>",           // defaults to fallbackTier
      "directTier": "<tier>",             // defaults to lowest rank
      "hysteresis": { "downTurns": 2 },
      "escalation": { "sameToolErrors": 2, "totalToolErrors": 3, "maxPerTask": 1 }
    }
  },

  "profileSelection": {
    "default": "<name>",
    "rules": [
      { "matchProvider": "github-copilot*", "profile": "<name>" },
      { "matchModel": "*/gpt-6*", "profile": "<name>" }
    ]
  },

  "subagents": {
    "enabled": true,
    "mode": "auto",                       // auto | child | launch
    "profile": null,                      // null = parent's active profile
    "accountAffinity": "parent",          // parent | none
    "exclude": ["<agent>"],
    "agents": { "<agent>": { "minTier": "@middle", "maxTier": "<tier>", "fixedTier": null } }
  },

  "failover": {
    "accountSiblings": "off",
    "overloadSwitchAfter": 2,
    "errorClasses": { /* pattern overrides, see 9.3 */ }
  },
  "metrics": { "piUsage": "auto", "ledger": { "retainDays": 30 } },
  "budgets": {                            // soft, warn only (9.7); also allowed per profile
    "task":    { "tokens": 2000000, "costUsd": 5 },
    "session": { "costUsd": 40 }
  },
  "exhaustion": { "borrow": ["up", "down"], "autoContinue": false, "maxWaitMs": 21600000 },
  "autoTier": { "nameHints": { "small": [], "large": [] } },   // extends the built-in hint list
  "live": { "mirror": true, "toolResultBytes": 4096, "retainHours": 24 },
  "state": { "shared": true },
  "ui": {
    "navigator": { "shortcut": "ctrl+alt+w", "refreshMs": 500, "widget": "auto" },
    "status": "{profile} · {tier} · {member} · {confidence}",
    "statusSub": "{routed} subagents routed",
    "entries": "collapsed"
  },
  "debug": { "log": false, "fullEvidence": false, "maxBytes": 5242880, "maxFiles": 3 }
}
```

### 7.2 Rule conditions

`when` is an object (all keys must match) or an array of objects (any must match).

| Question type | Forms | Meaning |
|---|---|---|
| choice | `"plan"`, `["plan","review"]`, `{ "not": "plan" }` | the chosen label |
| score | `"deep"` | the nearest level, `round(score)`, by label |
| score | `"<1"`, `">=1.5"` | the expected level index, `0` to `n-1` |
| bool | `true`, `false` | `probability >= 0.5` |
| bool | `">0.7"` | the probability of true |
| signal | `"$planMode": "planning"`, `"$scope": "subagent"`, `"$agent": "scout"` | exact or list match, confidence 1 |

A ruleset must end with exactly one default tier rule (no `when`). The built-in ruleset (ADR-0003), calibrated against recorded H2O-Lightning-4B answers (8.5):

```jsonc
{
  "tierRules": [
    { "when": { "$planMode": "planning" }, "tier": "@top" },
    { "when": { "work": ["plan", "review"] }, "tier": "@top" },
    { "when": { "depth": ">=1.5" }, "tier": "@top" },
    { "when": { "work": ["mechanical", "research"], "depth": "<1.0" }, "tier": "@bottom" },
    { "tier": "@middle" }
  ],
  "floorRules": [ { "when": { "risky": true }, "atLeast": "@middle" } ]
}
```

### 7.3 Profile selection

Checked in order; the first that yields a valid profile wins, and the decision records the source:

1. `manual-session`: `/tier profile <name>` (a control entry on the session branch).
2. `manual-global`: `/tier profile <name> --global` (`state.json`).
3. `project`: `profile` in `.pi/pi-switchboard.json`.
4. `match`: the first `profileSelection.rules` entry whose `matchProvider` or `matchModel` glob matches the origin model. Account providers such as `openai-codex-2` match `openai-codex*`.
5. `default`: `profileSelection.default`.

A profile with `projects` is skipped outside those paths.

### 7.4 Validation

Run on load and by `/tier validate`. Errors disable only the broken profile; others stay usable.

- Tier names in rules (and `fallbackTier`, `baselineTier`, `directTier`, `subagents.agents.*`) exist in each profile that uses them; rank keywords always pass.
- Exactly one default tier rule, in last position.
- Ranks are unique integers within a profile.
- Every member's model exists in the registry and its provider has credentials (`getProviderAuthStatus`). A missing member is disabled with a warning; a tier with no enabled member breaks the profile.
- Mixed context windows in one tier (largest more than 4x the smallest) produce a warning.
- Classifiers exist with type `classifier`. A classifier whose provider's base URL is not loopback, and is not pi's local llama.cpp provider, needs `allowRemote: true`, otherwise it is skipped with a warning.
- Several accounts of one base provider in one tier: one-time terms-of-service warning.
- `@alexeiled/pi-model-router` active: pi-switchboard refuses to register its virtual model and says why.

### 7.5 Worked example: two subscriptions

`examples/two-subscriptions.json` (illustrative only; never a built-in default):

```json
{
  "version": 1,
  "classifierProviders": [
    { "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1/", "models": ["h2o-lightning-4b"] }
  ],
  "classifiers": [{ "model": "lmstudio/h2o-lightning-4b", "timeoutMs": 2000, "threshold": 0.8 }],
  "profiles": {
    "copilot": {
      "ruleset": "builtin",
      "tiers": {
        "deep":     { "rank": 3, "members": ["github-copilot/claude-opus-5.5:high"] },
        "standard": { "rank": 2, "members": ["github-copilot/claude-sonnet-5.5:medium"] },
        "light":    { "rank": 1, "members": ["github-copilot/claude-haiku-5.5:low"] }
      },
      "fallbackTier": "standard"
    },
    "codex": {
      "ruleset": "builtin",
      "tiers": {
        "deep":     { "rank": 3, "members": ["openai-codex/gpt-6.1-sol:high"] },
        "standard": { "rank": 2, "members": ["openai-codex/gpt-6-luna:medium"] },
        "light":    { "rank": 1, "members": ["openai-codex/gpt-6-luna:low"] }
      },
      "fallbackTier": "standard"
    }
  },
  "profileSelection": {
    "default": "codex",
    "rules": [{ "matchProvider": "github-copilot*", "profile": "copilot" }]
  }
}
```

### 7.6 Worked example: mixed providers and a shared tier

`examples/mixed-providers.json`: plan on one subscription, implement on a tier shared across two subscriptions, run trivial steps locally, with a five-tier ladder that uses its own names and its own ruleset.

```json
{
  "version": 1,
  "rulesets": {
    "ladder": {
      "tierRules": [
        { "when": { "$planMode": "planning" }, "tier": "architect" },
        { "when": { "work": "plan", "depth": ">=1.5" }, "tier": "architect" },
        { "when": { "work": ["plan", "review"] }, "tier": "senior" },
        { "when": { "work": "implement", "depth": ">=1" }, "tier": "builder" },
        { "when": { "work": "mechanical", "depth": "<0.5" }, "tier": "intern" },
        { "when": { "work": "research", "depth": "<1" }, "tier": "clerk" },
        { "tier": "builder" }
      ],
      "floorRules": [{ "when": { "risky": true }, "atLeast": "senior" }]
    }
  },
  "profiles": {
    "mixed": {
      "ruleset": "ladder",
      "tiers": {
        "architect": { "rank": 5, "members": ["github-copilot/claude-opus-5.5:high"] },
        "senior":    { "rank": 4, "members": ["openai-codex/gpt-6.1-sol:medium"] },
        "builder":   { "rank": 3,
                       "strategy": { "name": "round-robin", "granularity": "session" },
                       "members": ["github-copilot/claude-sonnet-5.5:medium",
                                   "openai-codex/gpt-6-luna:medium"] },
        "clerk":     { "rank": 2, "members": ["github-copilot/claude-haiku-5.5:low"] },
        "intern":    { "rank": 1, "members": ["llama.cpp/qwen3.8-27b"] }
      },
      "fallbackTier": "builder",
      "directTier": "clerk"
    }
  },
  "subagents": {
    "agents": { "scout": { "maxTier": "clerk" }, "planner": { "minTier": "senior" } }
  },
  "profileSelection": { "default": "mixed" }
}
```

`examples/local-only.json` and `examples/single-tier.json` cover the remaining shapes from the spec.

### 7.7 Auto-tiering for `/tier init`

`/tier init` proposes a working config instead of empty tiers:

1. Candidates: chat models from `ctx.modelRegistry.getAvailable()` whose provider has credentials, excluding virtual models, classifiers and extra multi-pass accounts (`<provider>-<n>`).
2. Rank each candidate by catalog price (input and output weighted 3:1). Ties, and models without a price (local models), are ordered by the built-in name hints (words such as `mini`, `nano`, `flash`, `lite`, `small` rank low; `pro`, `max`, `ultra`, `large` rank high, plus family words), then by context window, then by maximum output tokens. Hints live in one source file, `src/autotier/hints.ts`; `autoTier.nameHints` adds to them.
3. Propose one profile per signed-in base provider, named after it, plus one mixed profile `all` across every provider. Each profile gets up to three tiers, `light` (rank 1, thinking `low`), `standard` (rank 2, `medium`) and `deep` (rank 3, `high`): the cheapest, the median and the most capable candidate, using distinct models where the provider has at least three. A provider with one or two models gets one or two tiers.
4. Add `profileSelection.rules` that match each provider to its profile, and set the default to the profile of the current model.
5. Add local classifiers found in the registry (`findOfType("classifier")` on loopback or llama.cpp providers). Remote classifiers are never added; the output explains how to add an LM Studio decision model.
6. Show the result as a diff and write it only after confirmation, then suggest `/tier models` to adjust it.

No profile is ever created implicitly at runtime: without a config the router stays inactive (4.7) until `/tier init` writes one.

## 8. Classification

### 8.1 Built-in question set

One classify call per decision answers all three:

```ts
const BUILTIN_QUESTIONS = {
  work: {
    type: "choice",
    instructions: "What kind of work does the latest request ask for?",
    criteria: {
      plan: "Designing, planning or choosing an approach before writing code",
      research: "Finding and reading information in code, docs or the web",
      implement: "Writing or changing code to build or fix something",
      review: "Checking existing work for defects, risks or quality",
      mechanical: "A small, fully specified step: rename, run a command, look up one fact, summarize",
    },
  },
  depth: {
    type: "score",
    instructions: "How much reasoning does doing this well require?",
    criteria: [
      "Shallow: the answer is obvious or a single step",
      "Moderate: a few steps or some judgement",
      "Deep: hard reasoning, many interacting parts or high ambiguity",
    ],
  },
  risky: {
    type: "bool",
    instructions: "Could a wrong or careless result be expensive or destructive?",
    criteria: {
      true: "Data loss, production or infrastructure changes, security, money, or irreversible actions",
      false: "Mistakes are cheap to notice and undo",
    },
  },
};
```

Score answers are expected level indexes (floats from 0 to 2), so `depth: "<0.5"` reads "clearly shallow". Custom question sets replace the built-in one; rulesets referencing unknown questions fail validation.

### 8.2 Evidence (the classifier `state`)

`state` is a JSON object; the same redacted object goes to the classifier, the decision entry (as an excerpt plus a digest) and the debug log, so replay sees exactly what the live classifier saw.

```jsonc
{
  "scope": "main",                    // or "subagent"
  "agent": null,                      // subagent: { "name": "scout", "tools": ["read","grep"] }
  "planMode": "executing",            // planning | executing | idle | unknown
  "editsThisTask": false,             // a successful edit/write since the last user message
  "previousTask": { "edits": true, "toolErrors": 1 },
  "toolOutcomes": [ { "tool": "bash", "ok": false }, { "tool": "read", "ok": true } ],
  "toolErrors": [ { "tool": "bash", "error": "npm ERR! missing script: …" } ],
  "request": "…head… [1,234 tokens omitted] …tail…"
}
```

Bounds (configurable): 4,000 tokens in total, estimated at 4 characters per token. The request gets up to 2,500 tokens, keeping its head and tail. At most 5 tool errors of 200 characters each. Tool output bodies are never included.

Redaction runs before anything leaves the process: `$HOME` becomes `~`, and bearer tokens, API-key shapes (`sk-…`, `ghp_…`, `AKIA…`, `xox…`), JWTs, private-key blocks and long hex or base64 runs become `«redacted»`. User patterns in `classification.evidence.redact` are added.

### 8.3 Classifier chain

Each entry is tried in order until one returns `stopReason: "stop"`. Each has its own timeout (default 2,000 ms) and the whole decision has a budget (default 4,000 ms). Classifier calls do not throw on provider errors, so `stopReason` and `errorMessage` are checked. When every entry fails, the decision uses the fallback tier and records `fallback:classifier-error` with each attempt's error. Classifier usage and cost come from `result.usage` and are recorded per decision.

### 8.4 Local classifier providers

Local classifiers come in two shapes, and pi-switchboard supports both through `classifierProviders[].api`:

| `api` | Server | Registered with |
|---|---|---|
| `system-one` (default) | anything that answers `POST <baseUrl>/systemone`: LM Studio, `llama-server` from llama.cpp build 11773 or later, the H2O shim in front of vLLM, SGLang or MLX, and other System One servers | pi-ai's System One implementation (API `typesafe-system-one`), a dummy key, the listed model ids with type `classifier` |
| `llama-cpp-classify` | pi's native llama.cpp provider, which also uses chat models as classifiers | nothing to register; reference `llama.cpp/<model>` in `classifiers` |

Nothing in the code is specific to one server; the README has a section per server. The System One wire format names the bool type `noul`; pi-ai maps `bool` to `noul` and back.

**Warm-up.** Local servers load a model on first use (LM Studio took 9 s for H2O-Lightning-4B). At `session_start`, pi-switchboard sends one background classify call with a fixed tiny state to every local classifier in the chain whose `warmup` is not `false`; it never blocks the session. `keepWarmMs` (default off) repeats it while idle so the server does not unload the model. A decision that times out before the warm-up has answered falls back and records `fallback:classifier-cold`, so cold starts are visible in the decision record and the calibration report.

**LM Studio specifics** (checked 2026-10-25): LM Studio treats a GGUF as a decision model only when its metadata has `<architecture>.decision.type` (read in LM Studio's main process; the llama.cpp engine 2.64.0 carries the decision support). MLX folders such as `netprojects/h2o-lightning-4b-mlx-q8` load as chat models and are rejected by `/v1/systemone` with "There are no downloaded decision models". The working setup is `h2oai/h2o-lightning-4b-gguf`, file `h2o-lightning-4b-Q8_0.gguf` (4.48 GB, sha256 `844c6b09…c740`, decision type `h2o-lightning`), in `~/.lmstudio/models/h2oai/h2o-lightning-4b-gguf/`; LM Studio lists it as `h2o-lightning-4b`, type `decision`. The `stock-` files in that repository have no decision type.

### 8.5 Calibration

Measured on 2026-10-25 with the built-in questions, H2O-Lightning-4B Q8_0 in LM Studio, 24 requests with expected tiers chosen beforehand (`test/fixtures/h2o-calibration.json`):

- Latency: 9 s cold, then 0.2–0.7 s per decision with all three questions; about 420 input tokens.
- `work` confidence: 0.82–0.95 on clear requests, 0.38–0.54 on tiny edits that sit between `mechanical` and `implement`.
- `depth` values are well ordered (shallow tasks 0.17–0.74, ordinary coding 0.97–1.23, design and hard debugging 1.82–1.87), but depth confidence is low throughout (0.29–0.79).
- `risky` separates destructive requests (0.87–0.93) from ordinary ones (0.07–0.37).
- The server's choice confidence is `(n·p_top − 1)/(n − 1)`, checked against the model card's example (0.9475 over 3 options gives 0.9213) and a recorded answer (0.5304 gives 0.2956).

| Ruleset | Correct tier |
|---|---|
| Nearest score label, score confidence gating, threshold 0.85 | 14/24 |
| Score by expected value, no score gating, threshold 0.85 | 18/24 |
| Same, threshold 0.80 (the built-in setup) | 21/24 |

At 0.80, every miss put a task one tier too high. At 0.85, one request, a hard debugging task classified `review` with confidence 0.83, fell to the fallback tier, one below its expected tier. The fixture backs the rule tests, so rule changes are checked against real model output.

## 9. Selection

### 9.1 Strategies

Every strategy declares its **selection granularity** and its fallback when its metric is missing. Ties always break by list order. All randomness comes from a seedable source.

| Strategy | Picks | Metric source | When the metric is missing |
|---|---|---|---|
| `ordered` | first healthy member | none | n/a |
| `sticky` (default) | the member that last served this session | router state | `ordered` |
| `round-robin` | next member after the shared pointer; granularity `session` (default), `task` or `request` (warned as cache-hostile) | shared state | random start offset |
| `weighted` | smooth weighted round robin by `weight` | shared state | `random` weighted |
| `random` | uniform, or weighted by `weight` | rng | n/a |
| `least-recently-used` | member idle longest | shared `lastUsedAt` | never-used members first |
| `least-in-flight` | fewest active requests, counting parallel children | shared leases | `ordered` |
| `quota-headroom` | most remaining quota | pi-usage, else ledger vs `budget` | members without data rank after those with data; none has data: `fallback` (default `ordered`) |
| `soonest-reset` | earliest reset among members with headroom ≥ 5% | pi-usage, else ledger window | same as above |
| `cheapest` | lowest catalog price (input:output weighted 3:1) | model catalog | unknown prices last |
| `largest-context` | largest context window | model catalog | unknown last |
| `fastest` | lowest time-to-first-token EWMA | shared latency samples | `ordered` until each member has 3 samples |
| `subscription-preferred` | members whose provider uses OAuth (`isUsingOAuth`) first, then by `fallback` | model registry | n/a |
| `scheduled` | members inside their `schedule` windows | clock | `fallback` |
| `custom` | `select(members, context)` from a user module | user | `fallback` on error or `undefined` |

`custom` modules are loaded with jiti from an absolute or `~/` path and receive a frozen copy of the candidates, their health and the decision context.

### 9.2 Modifiers

Applied with any strategy, in this order: `enabled` → cooldown → `maxConcurrency` → affinity → strategy.

- **Affinity** keeps the chosen member for `scope` `session` or `task`, optionally for `ttlMs`. It is keyed on the session ID (and task index), never on message text.
- **Cooldown** benches a member, or the (provider, model, account) triple when `scope: "provider-model-account"`. Duration: `retry-after` or `resets_at` from the error when present, else per-class defaults.
- **Selection timing**: members are selected only on `reason: "user"`, at subagent launch, on escalation, and on a retry whose error class calls for failover. A healthy member is never replaced before its granularity allows it.

### 9.3 Error classification

pi has no typed rate-limit error, so `failed.message.errorMessage` is classified by ordered, configurable patterns. Defaults (tests use real strings from pi-ai and pi-multi-pass):

| Class | Default patterns | Action | Default bench |
|---|---|---|---|
| `quota` | `usage.?limit`, `quota`, `limit.*reached`, `insufficient_quota` | next member | until `resets_at`, else 60 min |
| `rate-limit` | `rate.?limit`, `too many requests`, `\b429\b` | next member | `retry-after`, else 5 min |
| `overloaded` | `overloaded`, `capacity`, `\b529\b`, `\b503\b` | keep, switch after N | none |
| `auth` | `\b401\b`, `\b403\b`, `invalid[_ ]?(api[_ ]?key\|refresh[_ ]?token)`, `unauthorized` | next member | 60 min |
| `context-overflow` | `context.{0,20}(length\|window\|overflow)`, `too many tokens`, `prompt is too long` | keep (pi compacts) | none |
| `server` | `\b5\d\d\b`, `internal server error`, `timeout`, `ECONNRESET` | keep; after `allowedFails` (3 in 60 s) bench 60 s and switch | 60 s |
| `other` | anything else | keep | none |

`retry-after` is parsed from `retry after N s`, `Retry-After: N`, `try again in 1m30s`, `resets_at: <epoch or ISO>` and `resets in …`.

### 9.4 Shared health state and lock

`~/.pi/agent/pi-switchboard/health.json` holds round-robin pointers, smooth-weighted counters, `lastUsedAt`, in-flight leases, cooldowns and latency EWMAs, keyed by profile, tier and member. It is shared by the main session, foreground children, background runner children and other pi processes.

- Lock: `health.json.lock` created with `O_EXCL`, containing pid and timestamp; stale after 10 s; acquisition retries every 25 ms for up to 250 ms.
- Writes go to a temp file and are renamed into place.
- In-flight counts are leases (`pid`, `expiresAt`, renewed on each request), so a crashed process cannot leak them.
- When the lock is unavailable, the selection runs on an in-memory copy, round robin starts at a random offset, and the decision records `state:unshared`.

### 9.5 Usage ledger and quota metrics

Every assistant message routed by pi-switchboard appends `{ ts, session, task, provider, model, input, output, cacheRead, cacheWrite, cost }` to `~/.pi/agent/pi-switchboard/usage.jsonl` (rotated by `retainDays`). It feeds `/tier report`, the report CLI, and the quota strategies when pi-usage is absent: remaining headroom is `budget - used in window`, and the reset is the end of the current window. When pi-usage is installed, its answer takes precedence (below). It is not installed on this machine, so only the ledger path has run against real data.

**pi-usage** (`src/selection/pi-usage.ts`). The client follows pi-usage's `docs/api/usage-v1.md`: emit `usage:query:v1` with `{ session, sessionId, providerId, refresh, signal, respond }`; the service offers a value or promise through `respond()` before its handler first awaits, no offer means no service, and the request is aborted at the deadline. `refresh: true` is required, because cache-only reads currently return `cache-miss`. A report's buckets give `remaining` or `used` against a `limit` (percent buckets default to 100), `modelKeys` and `resetsAt` in milliseconds; for a model the tightest applying bucket is its quota, and buckets with unknown measurements are skipped, so a report with no usable buckets (a ChatGPT Business account) is no quota. Selection reads a synchronous cache that is refreshed in the background, at session start, on each user turn when stale, and after `usage:changed:v1`, and only for providers used by a `quota-headroom` or `soonest-reset` tier. Reports are trusted for five minutes or until the service's own `expiresAt`; a missing service backs off for ten minutes and a failed read for two.

### 9.6 Tier exhaustion

When every member of the chosen tier is cooling down or disabled:

1. **Borrow** from the nearest tier above that has a healthy member, then from the nearest tier below (order configurable in `exhaustion.borrow`). Children borrow only within their `minTier` and `maxTier`. The decision is recorded with `kind: "borrowed"`, and the footer shows the borrowed tier.
2. If every tier is exhausted, `route()` throws an error that names the earliest reset (`pi-switchboard: every model is cooling down; earliest reset 14:05 on <member>`). No provider request is made, and pi does not retry the error, so the turn ends with that notice.
3. With `exhaustion.autoContinue: true` (off by default), pi-switchboard sends `continue` as a follow-up user message at the earliest reset, waiting at most `maxWaitMs` (6 h). The widget shows a countdown, and `/tier resume cancel` stops it. This is the only case where pi-switchboard sends a message for the user, and it fires at most once per exhaustion. The failed request ran no tools, so continuing repeats no side effects.

### 9.7 Budgets

Soft budgets on tokens and estimated cost, per task and per session, set globally or per profile. Cost is estimated from catalog prices, which pi lists even for subscription models. When a budget is crossed, pi-switchboard notifies once per budget, marks the footer and widget, and records `budget: { scope, metric, used, limit }` on later decisions. Routing never changes because of a budget. `/tier budget` shows spend against each budget. No budgets are set by default.

## 10. Records

### 10.1 Router state (virtual-model state)

```ts
interface RouterState {
  v: 1;
  profile?: { name: string; source: ProfileSource };
  tier?: string;
  member?: string;          // "provider/id:thinking"
  task: number;             // count of user turns seen
  downVotes: number;
  escalatedTask?: number;   // task index of the last escalation
  originModel?: string;
  lastDecisionId?: string;
}
```

A new object is returned only when something changed, as pi stores every returned object. Pin, dry-run and the manual profile live in control entries (`pi-switchboard.control`), because they are set by commands outside `route()`.

### 10.2 Decision entry (`customType: "pi-switchboard.decision"`)

```ts
interface DecisionEntry {
  v: 1;
  id: string;                         // "d_" + ULID
  ts: string;
  task: number;
  scope: "main" | "subagent";
  reason: "user" | "continuation" | "retry" | "direct" | "launch";
  kind: "classified" | "fallback" | "pinned" | "dry-run" | "held" | "escalated"
      | "failover" | "borrowed" | "direct" | "inactive";
  profile: { name: string; source: ProfileSource; rule?: number };
  evidence?: { digest: string; excerpt: string; tokens: number; truncated: boolean };
  classifier?: {
    model: string; latencyMs: number;
    attempts: { model: string; ok: boolean; error?: string; latencyMs: number }[];
    usage?: { input: number; output: number; cost: number };
  };
  answers?: Record<string, { type: string; value: string | number | boolean;
                             confidence: number; probabilities?: Record<string, number> }>;
  rules?: {
    ruleset: string; matched: number;
    gate: { referenced: string[]; confidence: number; threshold: number; passed: boolean };
    floors: { index: number; atLeast: string; confidence: number; applied: boolean }[];
  };
  tier: { candidate: string; chosen: string; previous?: string; rank: number;
          why: string; downVotes?: number };
  selection: {
    strategy: string; granularity: string; why: string; metricFallback?: string;
    candidates: { member: string; eligible: boolean; excluded?: string;
                  health: { cooldownUntil?: string; fails?: number; inFlight?: number;
                            quota?: { remaining: number; resetsAt?: string; source: string } } }[];
    chosen: string; shared: boolean;
  };
  model: { provider: string; id: string; thinking?: string; contextWindow?: number;
           account?: string; subscription: boolean };
  switch: { from?: string; cacheMiss: boolean };
  error?: { class: string; message: string; benchedUntil?: string };
  subagent?: { agent: string; taskIndex: number; toolCallId: string;
               mode: "child" | "launch" | "skipped"; skipped?: string;
               launchTier?: string; maxTier?: string };
  budget?: { scope: "task" | "session"; metric: "tokens" | "costUsd"; used: number; limit: number }[];
  dryRun?: boolean;
}
```

A `pi-switchboard.link` entry, written on the `subagent` tool result, maps `{ decisionId, runId, sessionFile, model }` for each task, because the run ID does not exist yet at launch.

Entries are written for every `user`, `launch`, `escalated`, `failover`, `direct` and `inactive` decision; plain continuations write nothing (the assistant messages already record the physical model). A `pi-switchboard.profile` entry snapshots the active profile's tiers, members and catalog prices whenever the profile activates or changes, so the inspector can price counterfactuals offline.

### 10.3 Debug log

Opt-in JSONL at `~/.pi/agent/pi-switchboard/decisions.jsonl`, one decision per line plus `session` and `cwd`, rotated at `maxBytes` with `maxFiles` kept. Evidence appears as digest and excerpt only, unless `debug.fullEvidence` is on. No credentials, headers or full prompts.

## 11. Observability

### 11.1 Footer

Two status keys, templated:

| Key | Default template | Example |
|---|---|---|
| `tier` | `{profile} · {tier} · {member} · {confidence}` | `copilot · deep · claude-opus-5.5 · 0.92` |
| `tier-sub` | `{routed} subagents routed` (hidden at 0) | `3 subagents routed` |

Placeholders: `{profile} {tier} {rank} {member} {model} {provider} {account} {thinking} {strategy} {confidence} {reason} {kind} {switches} {routed}`. States: `switchboard off` (manual model), `switchboard inactive: <reason>`, `pinned` and `dry-run` markers. README snippet for `powerline.customItems`:

```json
{ "id": "tier", "statusKey": "tier", "position": "right", "prefix": "⇄", "hideWhenMissing": true },
{ "id": "tier-sub", "statusKey": "tier-sub", "position": "right", "hideWhenMissing": true }
```

### 11.2 TUI entry renderer

Decision entries render inline, collapsed to one line (`⇄ task 4 · implement/0.91 · standard → claude-sonnet-5.5 (sticky)`); expanding shows answers, rule, gate, floors, candidates and the switch. Custom entries never enter LLM context.

### 11.3 Commands

| Command | Does |
|---|---|
| `/tier` | Status: profile and its source, tier, member, pin, dry-run, last 5 decisions |
| `/tier init` | Propose a config from the signed-in models (7.7), show the diff, write after confirmation |
| `/tier models` | Interactive tier editor (11.7) |
| `/tier watch` | Live navigator overlay (11.5); also `ctrl+alt+w` |
| `/tier budget` | Spend against each budget for this task and session |
| `/tier resume cancel` | Cancel a pending auto-continue (9.6) |
| `/tier profile <name\|auto> [--global]` | Choose or clear the manual profile |
| `/tier pin <tier\|@keyword\|auto> [--subagents]` | Pin the main session (and optionally subagents) |
| `/tier dry-run on\|off` | Classify and record, route to the baseline tier |
| `/tier log [n]` | Last n decisions |
| `/tier explain <id>` | Evidence, answers, rules, candidates for one decision |
| `/tier health` | Members, cooldowns, in-flight leases, ledger headroom |
| `/tier report` | Cost per task, tier, member and provider for this session; confidence histogram and fallback rate |
| `/tier inspect [--open]` | Write the inspector HTML for this session and open it |
| `/tier validate` | Re-run config validation |

### 11.4 Inspector, replay and report

All three share `timeline/`, which parses a session JSONL into tasks. A task holds the user request, its decisions, every request (reason, physical model, thinking, tokens in, out, cache read and write, cost, duration from entry timestamps), every tool call with its result status, model switches marked as cache misses, and subagent runs nested by decision ID and run ID, with their own child sessions parsed recursively.

- **Inspector** (`/tier inspect`, `pi-switchboard inspect <session.jsonl> [-o file.html] [--open]`): one self-contained HTML file with the data embedded and no network access. Summary header: cost by tier, member and provider, token share per subscription, switch count, fallback rate, confidence histogram, and counterfactual cost (the same tokens priced on the profile's top tier and on its baseline tier, labelled as an estimate that ignores cache effects). Task rows expand to the decision, the requests table and the tool-call timeline; raw evidence is behind a toggle. Filters: tier, member, fallbacks only, switches only.
- **Replay** (`pi-switchboard replay <session.jsonl> [--reclassify] [--json]`): a text timeline of tasks, decisions, models and tool calls, built offline from the recorded answers. With `--reclassify`, it re-runs the classifier chain on the stored evidence with the current config and shows which decisions would change. Outside pi, the CLI loads pi's model registry from the installed release (located through `~/.local/bin/pi` or `PI_PACKAGE_DIR`) with jiti, so the same classifier providers and credentials resolve as inside pi; without a reachable classifier it says so and prints the offline timeline.
- **Report** (`pi-switchboard report [--since 7d] [--sessions <dir>]`): aggregates across sessions from the usage ledger and decision entries.

pi's `/export` HTML filters out custom entries (`template.js` treats `custom` as a settings entry), and pi-session-viewer shows custom entries only as a generic "Custom event" line. The inspector is therefore the supported way to review decisions; native export still shows the physical model of each message.

### 11.5 Live navigator and widget

**Navigator** (`/tier watch` or `ctrl+alt+w`): an overlay through `ctx.ui.custom({ overlay: true })`, refreshed every 500 ms while open.

```text
⇄ switchboard · copilot · 3 running · deep 1 · standard 1 · light 1 · $0.42 · budget ok
┌ task 7  main      standard  claude-sonnet-5.5      turn 3  edit        41k/12k  38 t/s  $0.18
│ ├ scout   [fg]    light     claude-haiku-5.5       turn 5  grep         9k/2k   71 t/s  $0.01
│ ├ reviewer[bg]    deep      claude-opus-5.5 (#2)   turn 2  read        22k/0k   24 t/s  $0.21
│ └ worker  [bg]    standard  gpt-6-luna ↺1 failover done              31k/18k          $0.02
cooldown: openai-codex/gpt-6.1-sol until 14:05 (rate limit)
↑↓ move · enter decision · t transcript · esc close
```

- Rows: the current main-session task and every pi-subagents child that pi-switchboard routes, nested under the task that launched it, with nested children nested again.
- Columns: status, agent, foreground or background, tier (with `borrowed` or `escalated` markers), model and account, turn, current tool, fresh and cached tokens, tokens per second, cost, switches and failovers.
- Footer lines: members in cooldown with their resets, budget warnings, a pending auto-continue countdown.
- `enter` opens the row's decision (answers, rule, gate, floors, candidates). `t` opens the transcript viewer: a scrollable view of the child's mirror (11.6) or of the main session branch, following the tail while the child runs. `esc` goes back, then closes.

**Widget**: one line above the editor through `ctx.ui.setWidget`, shown only while children are running or an auto-continue is pending, for example `⇄ 3 running · deep 1 · standard 1 · light 1 · $0.42`. `ui.navigator.widget: "off"` hides it.

On this machine, `ctrl+alt` shortcuts need Ghostty's `macos-option-as-alt`; the shortcut is configurable.

### 11.6 Child live status and transcript mirror

pi-switchboard is loaded into every native child (5.4), so each child publishes its own progress; nothing reads pi-subagents' internal files.

- `~/.pi/agent/pi-switchboard/live/<child session id>.json`: status, agent, parent session, launch model, current model, turn, current tool, tokens, cost, tokens per second, started and ended times. Each child writes only its own file, atomically, at most every 250 ms, so no lock is needed.
- `~/.pi/agent/pi-switchboard/live/<child session id>.jsonl`: the transcript mirror. The task, assistant text (8 KB per message), tool calls with bounded arguments (1 KB), tool results (`live.toolResultBytes`, default 4 KB) and errors, all redacted with the evidence redactor (8.2). Thinking blocks are not mirrored.
- The parent joins a child to its launch decision by a digest of agent and task text written at launch, or, failing that, by parent session, agent, model and start time (marked approximate).
- Mirrors are deleted 24 hours after their child ends (`live.retainHours`), by a sweep at session start. `/tier inspect` embeds the mirrors of the session's children, so the inspector keeps working after the sweep, including for in-memory children that never wrote a session file.

### 11.7 Tier editor

`/tier models` opens an overlay for profiles, tiers and members:

- Profiles: create, rename, delete; set the profile-selection default.
- Tiers: add, rename, delete, set rank and strategy; set the fallback, baseline and direct tiers.
- Members: add from a picker of signed-in models (virtual models and classifiers excluded), set thinking level, weight and enabled, reorder.
- Target: the global or the project file. Saving validates the result (7.4), shows a diff, writes a `.bak`, writes the file, and reminds you to `/reload` so the virtual models re-register.

Rulesets, classifiers, budgets and selection rules stay hand-edited JSON.

## 12. Plannotator

Before each task, pi-switchboard emits on `plannotator:request` with `action: "plan-mode"` and `payload: { mode: "status" }`, and waits up to 100 ms. The answer's `phase` (`idle`, `planning` or `executing`) becomes the `$planMode` signal and part of the evidence. With no answer, the phase is `unknown`. Plannotator's own per-phase model must stay unset while routing; `/tier validate` warns if it is set.

## 13. Privacy and safety

- Network calls go only to configured classifiers; non-loopback classifiers need `allowRemote`.
- pi-switchboard never reads `auth.json`, `mcp-auth.json` or other credential files. It reads `multi-pass.json` for account labels only.
- Evidence is redacted once; logs never hold credentials, headers or full prompts by default.
- Every model switch is counted and recorded with its reason.
- Child transcript mirrors put tool output on disk; they are redacted, capped per entry and deleted after 24 hours (11.6).
- pi-switchboard sends a message for the user only through opt-in auto-continue (9.6).

## 14. Testing

Runner: `node --test` with Node's built-in type stripping (Node ≥ 22.19), so tests need no dependencies. Code is written as erasable TypeScript (no enums, no parameter properties, `.ts` import extensions) so the same files load under jiti in pi and under plain Node in tests and the CLI. Typecheck: `tsc --noEmit --strict` with `paths` mapping `@earendil-works/*` to the installed 1.3.0 declarations.

- Unit (fake registry, fake classifier, fake clock, seeded rng): rule matching, tier targets, gating, floors, threshold fallback, hysteresis, pin, dry-run, continuation cache-keeping, escalation triggers and cap, retry per error class, direct context fit, evidence bounding and redaction, config merge and validation, profile selection by glob and project, fail-soft paths, account providers (`openai-codex-2`) with both `accountAffinity` values.
- Flexibility: a three-provider profile, a single-tier profile, a five-tier profile with custom names, a local-only profile, missing config.
- Strategies: every strategy for distribution, granularity, affinity TTL, cooldown with `retry-after`, `allowedFails`, overload not benching, missing-metric fallback, mixed providers, a custom module, two parallel processes sharing a pointer through the locked state file.
- Error classification against real strings from pi-ai and pi-multi-pass.
- Coexistence: simulated multi-pass `model_select`, account siblings on and off.
- Subagents: explicit model precedence, parallel tasks, child and launch modes, excluded agents, `minTier`, `maxTier`, `fixedTier`.
- Source scan: fails if any provider or model ID from `examples/` or test fixtures appears in `src/`. The name-hint words in `src/autotier/hints.ts` are allowed; a separate test checks that the file holds single words, not model IDs.
- Auto-tiering: ranking by price, hint and context tiebreaks, unpriced local models, providers with one, two and many models, account providers excluded, the mixed profile.
- Exhaustion and budgets: borrowing up then down, child borrowing limits, the all-exhausted error, auto-continue scheduling and cancel with a fake clock, budget crossing notified once.
- Live: status and mirror writing with bounds and redaction, the retention sweep, joining children by digest and by fallback, navigator and widget rendering from fixture live files.
- Tier editor: edits produce valid config, the diff and `.bak` are written, validation failures block saving.
- Integration: load the extension with jiti against pi 1.3.0, drive `route()` with recorded requests; run replay and inspect on a fixture session.
- Calibration: the built-in ruleset scores at least 21/24 on `test/fixtures/h2o-calibration.json`, and no case lands below its expected tier.
- Warm-up: one background call per local classifier, cold-start fallback recorded, `keepWarmMs` timer with a fake clock.
- Manual smoke test against LM Studio's `/v1/systemone` with `h2o-lightning-4b`, documented in the README with the exact commands.

## 15. Implementation plan

Small Conventional Commits, each with its tests:

1. `chore: scaffold package` (manifest, tsconfig, test runner, source-scan test)
2. `feat(config): schema, loading, merging and validation`
3. `feat(rules): tier rules, floors, tier targets and gating`
4. `feat(classifier): system one providers, chain, evidence and redaction`
5. `feat(selection): strategies, modifiers, error classes, shared state, ledger`
6. `feat(router): switchboard virtual model`
7. `feat(subagents): launch classification and child routing`
8. `feat(record): decision entries, renderer, footer and debug log`
9. `feat(commands): /tier`
10. `feat(cli): timeline, replay, inspector and report`
11. `feat(live): child status, transcript mirror and retention`
12. `feat(tui): navigator, widget and tier editor`
13. `feat(init): auto-tiering and budgets`
14. `docs: readme, examples and json schema`

Done means: all tests pass, typecheck is clean, `pi -na` loads the extension without warnings, the footer shows the tier, a decision renders in the TUI, and the inspector shows it.

## 16. Decision log

| # | Decision |
|---|---|
| 1 | Package `pi-switchboard` in `~/Projects/pi/pi-switchboard`; command `/tier`; entry types `pi-switchboard.*`; config `pi-switchboard.json` |
| 2 | Profiles reference named rulesets (or inline ones); validation per profile |
| 3 | Gating confidence = minimum confidence of answers the matched rule references; default rule has no gate (amended by 57: score answers do not gate) |
| 4 | All strategies ship in v1 |
| 5 | Asymmetric hysteresis: up at once, down after 2 consecutive lower turns |
| 6 | Escalation lasts until the next user turn |
| 7 | Baseline tier = routing deliberately inactive; fallback tier = classifier failed or unconfident |
| 8 | Direct requests walk up ranks until the context window fits |
| 9 | Built-in rank-relative ruleset (ADR-0003) |
| 10 | Tier rules (first match) plus floor rules (all that match) |
| 11 | Task = one user turn plus its subagent runs |
| 12 | `/tier pin` covers the main session; `--subagents` extends it |
| 13 | Rank keywords `@top`, `@middle` (upper median), `@bottom` |
| 14 | Rulesets may mix tier names and rank keywords; profiles without rules use the built-in ruleset |
| 15 | Built-in rules: plan, review or deep to `@top`; shallow mechanical or research to `@bottom`; else `@middle`; risky at least `@middle` |
| 16 | Global manual profile lives in `state.json`; config is never rewritten |
| 17 | Classifier chain; non-local entries need `allowRemote` |
| 18 | 2,000 ms per classifier, 4,000 ms per decision |
| 19 | Evidence budget 4,000 tokens, including short tool errors |
| 20 | Threshold 0.85, plus a calibration section in the report |
| 21 | One redacted evidence copy for classifier, entry and log |
| 22 | Escalation triggers: same tool errors twice, 3 errors in total; at most 1 per task |
| 23 | Default strategy `sticky` |
| 24 | Strategy granularity decides when a healthy member may change |
| 25 | Subagents: child-side virtual model, launch-time fallback (ADR-0001, amended by 41) |
| 26 | pi-switchboard owns failover while routing; `accountSiblings` opt-in (ADR-0002) |
| 27 | Built-in inspector instead of relying on `/export` |
| 28 | Quota metrics from pi-usage, else the local usage ledger |
| 29 | Inspector is a static, self-contained HTML file |
| 30 | Inspector covers one session and its subagent sessions; report CLI for cross-session |
| 31 | Inspector content includes the tool-call timeline |
| 32 | Counterfactual cost shown, labelled as an estimate |
| 33 | The parent classifies subagent tasks at launch |
| 34 | Children may escalate, capped by `maxTier` |
| 35 | ADRs for 25, 26 and 9 |
| 36 | Write this document, then stop for review |
| 37 | Quota and usage-limit errors are rewritten in `message_end` so pi retries them, only while routing and only when another healthy member exists |
| 38 | Examples and smoke test use H2O-Lightning-4B |
| 39 | Register `switchboard/<profile>` for each valid profile next to `switchboard/auto` |
| 40 | Shift+Tab thinking level is an offset on the member's configured level |
| 41 | The launch tier reaches children through tier-pinned models `switchboard/<profile>.<tier>` (replaces `extensionBindings`) |
| 42 | Tier-pinned models kept after weighing a single `switchboard/child` with child-side classification; the extra `/model` entries are an accepted cost, and workflow-script children stay uncovered |
| 43 | `replay --reclassify` works outside pi by loading pi's model registry from the installed release |
| 44 | Structured chain steps are routed at launch like parallel tasks |
| 45 | Upstream PR #3049 to pi-subagents restores `extensionBindings` for foreground children (not attempted before; regression from #1844) |
| 46 | No integration with pi-dynamic-workflows; its useful features are rebuilt here |
| 47 | v1 adds a live navigator and widget, an interactive tier editor, auto-tiering for `/tier init`, budgets and tier-exhaustion handling |
| 48 | The navigator includes a transcript viewer fed by our own child mirrors, kept 24 hours |
| 49 | `/tier init` and the tier editor may rewrite config, after a diff and confirmation, with a `.bak` (amends 16) |
| 50 | Auto-tiering proposes one profile per provider plus a mixed `all` profile |
| 51 | Budgets only warn; routing never changes because of a budget |
| 52 | An exhausted tier borrows up, then down; when everything is exhausted the turn ends with the earliest reset, and auto-continue is opt-in |
| 53 | Auto-tiering uses a built-in list of name hints as a tiebreak, kept in one source file and allowed by the source scan |
| 54 | The tier editor covers profiles, tiers and members; rulesets, classifiers and budgets stay in JSON |
| 55 | The navigator opens as an overlay through `/tier watch` and a shortcut, plus a widget shown only while children run |
| 56 | The classifier is H2O-Lightning-4B Q8_0 GGUF in LM Studio; verified working before the build |
| 57 | Score answers are judged by their expected value and never gate a rule |
| 58 | Thresholds are per classifier (H2O at 0.80), with 0.85 as the global default and a profile override |
| 59 | The built-in ruleset is the calibrated form, and the recorded H2O answers are a test fixture |
| 60 | Local classifiers get a background warm-up and cold-start recording, for any local server (System One HTTP or pi's llama.cpp provider) |
| 61 | Yes/no confidence is `\|2p − 1\|`, the same scale as choice confidence (amends 3) |
| 62 | DESIGN.md approved as the build specification (2026-10-25) |
| 63 | Use `extensionBindings` for exact linking only; tier-pinned models stay the routing channel (works on every pi-subagents version and for parallel tasks) |
| 64 | Agents with an external runner are never routed (found while adding bindings: they would have received a model they cannot use) |
| 65 | Launch mode runs the tier's strategy over healthy members, with leases (it took the first member before) |
| 66 | pi-usage is read in the background, only for providers that a quota strategy uses, and wins over the local ledger |
| 67 | The terms-of-service notice for pooled accounts is shown once and remembered in `state.json` |

Derived in this document (not asked, flag if wrong): unconfident decisions never lower the tier (4.1 step 5); `$planMode: planning` is a built-in top-tier rule (7.2); escalation climbs one rank, not to `@top` (4.2); the virtual model lives under its own provider id (4); when pi-subagents' preflight cannot tell whether an agent's model is pinned, the task is treated as pinned and left alone (5.3); hysteresis does not apply to subagent launches (5.3); `/tier init` is the only way auto-tiered profiles appear, never implicitly at runtime (7.7); the all-exhausted case throws from `route()` instead of sending a request that would fail (9.6); the navigator shortcut defaults to `ctrl+alt+w` (11.5).

## 17. Open questions

None. Resolved: reclassify outside pi (43), chains (44), upstream bindings PR (45), `/model` size (42), decision model in LM Studio (56).

## 18. Sources

- pi 1.3.0 docs: `virtual-models.md`, `models.md` (classifier models), `codemode.md` (classify types), `session-format.md`, `extensions.md`; example `jev-router.ts`.
- pi `/export` template: `dist/core/export-html/template.js` (custom entries filtered as settings entries).
- pi-multi-pass `extensions/multi-sub.ts` (patterns, cooldown, `agent_end` handler).
- pi-subagents docs: `configuration.md`, `models.md`, `agents.md` (required host extensions), `tool-reference.md`, `extension-api.md`, `workflows.md`, `CHANGELOG.md`; source: `src/runs/shared/child-launch.js`, `child-session.js`, `extension-bindings.js`, `src/extension/schemas.js`, `subagent-executor.js`.
- pi-ai `dist/utils/retry.js` (`isRetryableAssistantError`, non-retryable quota patterns).
- Prior-art survey of 13 router packages and LiteLLM routing (session scratchpad `prior-art.md`).
- Plannotator `plannotator-events.ts` (`PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request"`, phases `idle | planning | executing`).
- `~/.pi/agent/extensions/subscription-status.ts` (account and OAuth detection without reading credentials).

## 19. Build notes (2026-10-26)

### Changes made during the build

| Area | Design said | Built | Why |
|---|---|---|---|
| pi version | 1.3.0 | 1.4.0 | pi was upgraded during the session; every API used is unchanged. |
| Retry times | parsed from error text | also from `after_provider_response` headers (`retry-after`, `retry-after-ms`, `x-ratelimit-reset*`) | 1.4.0 documents the event; headers are exact. |
| Cooldown scope | per member, or per physical model | by error class: usage limits and failed logins bench the whole provider account, rate limits the physical model, other errors the tier member | A live run showed a usage limit on one model also blocked every other model on that account. |
| Errors pi does not retry | rewrite and fail over | when no other model can take over, the failure is recorded at once, so the next turn refuses with the earliest reset instead of hitting the account again | Seen live: without it, every new turn re-hit the exhausted account. |
| Decision evidence | digest and excerpt | also the redacted classifier input (`evidence.state`) | Lets `replay --reclassify` re-run the classifier on exactly what it saw; session files already hold the unredacted conversation. |
| `--reclassify` outside pi | loads pi's model registry | calls local System One classifiers through pi-ai's own client; remote classifiers need pi | Avoids rebuilding pi's registry and credentials outside pi. |
| Tier editor | an overlay | pi's built-in select, input and confirm dialogs | Same capabilities with less custom UI code. |

### Verified

- 168 unit tests, strict typecheck clean against pi 1.4.0, extension loads with `pi -e` and registers `switchboard/auto`, one model per profile and one per tier.
- LM Studio classifier: `h2o-lightning-4b` (Q8_0 GGUF) answers through pi-ai's System One client; 24-request calibration recorded in `test/fixtures/h2o-calibration.json`.
- Live main-session routing: classified (`work=mechanical`, 0.94) to the light tier and answered by a local model; a planning request went to the deep tier; replay with `--reclassify` reproduced the tier.
- Live failover on a real usage limit (Codex): borrowed tiers on the same account were skipped, the turn ended with the provider's error, and the next turn refused before sending a request, naming the earliest reset.
- Inspector and replay on real sessions.

### Not verified end to end

- **A model-launched pi-subagents child on a tier-pinned model.** Both subscriptions were over quota during the build. Local attempts failed for reasons outside pi-switchboard: a 4B model called the `subagent` tool with the wrong arguments, a test tool cannot reach `subagent` through `ctx.executeTool` (it is not in the callable set), pi-subagents' `/run` fails in print mode with a stale context, and a 35B local model did not finish within 10 minutes. The launch rewriting, tier choice and child-side routing are covered by unit tests. Manual check: select `switchboard/auto`, ask for a subagent, then `/tier watch` and the child's decisions in `/tier log`.
- **Interactive TUI** (navigator overlay, widget, tier editor, `/tier` output): rendering and editor flows are unit-tested; they have not been driven in a live terminal.

### Operational finding

LM Studio's just-in-time loading keeps only the last loaded model by default. When it serves both the classifier and chat models, the classifier warm-up and a chat request evict each other ("Model is unloaded"). Load models explicitly or disable that option (README).

### Update 2026-10-26: pi-subagents #3049 merged

- Exact child linking through `extensionBindings` (5.7, decision 63); verified against pi-subagents' own binding validator at the 48-launch maximum (3.2 KB).
- Fixed: agents with an external runner were routable and would have received a `switchboard/...` model (decision 64).
- 173 unit tests, typecheck clean.

### Update 2026-10-26: follow-up work

Eight gaps found after the first build were closed, plus three bugs found while closing them. Tests: 215 unit and 13 integration, typecheck clean.

| # | Gap | Now |
|---|---|---|
| 1 | `allowRemote` was not enforced | A remote classifier (judged by its server's address) is skipped with a recorded reason unless the entry sets `allowRemote`. |
| 2 | `/tier inspect` had no handler | Writes the HTML inspector from the session's entries (so ephemeral sessions work), `--open` launches it, `-o` picks the path. |
| 3 | In-flight counts were always 0 | Requests hold a lease while they stream; launch-mode children hold one from launch until a foreground call returns (a background child's lease expires on its own after 15 minutes). |
| 4 | Missing validation | Session start and `/tier validate` warn about Plannotator phase models (all three config layers), a project `multi-pass.json` `allowedSubs` that omits `switchboard`, and classifiers that are unregistered or remote without `allowRemote`. The terms-of-service notice is shown once (`state.json`). |
| 5 | pi-usage not read | Implemented (9.5). |
| 6 | `cooldown.defaultMs` ignored | A rate-limited member sits out for the tier's `cooldown.defaultMs` when the provider gives no time (default 5 minutes). |
| 7 | Inspector lacked in-memory children | A child with no session file is rebuilt from its transcript mirror, joined to its launch decision by the id its binding carried. |
| 8 | No integration test | `test/integration/extension.test.ts` loads the extension through jiti against `test/support/fake-pi.ts` (registry, classifier, Plannotator and a stand-in pi-subagents, in a temp agent directory). Auto-continue now has its own class and fake-timer tests, and `projects`-restricted profiles are tested. |

Bugs found and fixed on the way:

- **Launch mode ignored the strategy.** It took the first enabled member of the tier, skipping the tier's strategy, cooldowns and health. It now selects like the main session does, borrowing within the agent's tier limits, and skips the task when the whole neighbourhood is cooling down.
- **A usage limit was not recorded when the engine had no current route** (for example right after `/reload`), so the next turn hit the exhausted account again.
- **A project pattern `~/work/**` did not match `~/work` itself.**

Decisions 65 to 67: launch mode runs the tier's strategy; pi-usage is read in the background only for providers that quota strategies use; the terms-of-service notice is shown once.

Still not verified: a model-launched pi-subagents child on a tier-pinned model (waiting for subscription quota and the pi-subagents release after 0.82.1), and the interactive TUI.
