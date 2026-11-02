# How pi-switchboard picks and fails over physical models, and how it uses usage:query:v1 buckets

## Summary

- **Pi calls the virtual model’s `route()` before each model request.** Switchboard chooses a physical model there, after `input` and `before_agent_start`; the selected `ctx.model` remains virtual. Tool continuations normally keep the previous physical model, but escalation and retry failover can change it. [node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-24,65-89; packages/pi-switchboard/src/router/engine.ts:692-850]
- **There is no generic pre-send extension event carrying the physical provider/model.** `before_provider_request` supplies an opaque payload; `before_provider_headers` supplies headers. `provider_stream_event` identifies the physical model, but it observes the response stream, not a pre-send authorization point. [node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:692-719; node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:223-252]
- **Switchboard failover does not select a different session model.** It returns a different dispatch target from `route()`, records a custom decision entry, and leaves the virtual selection intact. There is no switchboard routing notification on `pi.events`. [packages/pi-switchboard/src/runtime.ts:204-215,500-645; packages/pi-switchboard/src/router/engine.ts:754-850; packages/pi-switchboard/DESIGN.md:119-135]
- **An exhausted, usable usage bucket excludes a member before every selection strategy**, not merely ranks it last under `quota-headroom`. Unknown quota does not exclude it. [packages/pi-switchboard/src/selection/select.ts:84-124]
- **USD and count buckets work**, provided they supply a positive `limit` and `remaining` or `used`. Switchboard uses the smallest remaining fraction among applicable buckets; percent buckets default to a limit of 100. [packages/pi-switchboard/src/selection/pi-usage.ts:151-174]
- **Usage data is asynchronous cached input, not a synchronous authorization service.** Invalidation marks reports stale but does not remove them or immediately refresh them; cache reads continue returning stale reports. User-route refresh starts after routing succeeds. [packages/pi-switchboard/src/selection/pi-usage.ts:213-274; packages/pi-switchboard/src/runtime.ts:410-423,500-590]
- **No documented, versioned external cooldown/block API exists in the inspected switchboard sources.** Its existing versioned integration is the read-only `usage:query:v1` protocol, not an authoritative “do not dispatch” contract. [packages/pi-switchboard/DESIGN.md:119-135,707-711; packages/pi-switchboard/src/selection/pi-usage.ts:4-10]
- **Account-guard explicitly accepts the virtual-model blind spot.** It checks the virtual selection as its own Account; its mid-turn protection catches `model_select` changes, not switchboard’s invisible physical rerouting. [packages/pi-account-guard/docs/adr/0004-virtual-model-is-its-own-account.md:7-19; packages/pi-account-guard/DESIGN.md:330-354]

## 1. When the physical model is chosen, and what another extension can observe

### Request ordering

Pi documents `route(request, ctx)` as running **before every request** with a virtual model. Reasons are:

| Reason | Meaning |
|---|---|
| `user` | First request after a user-written message, including steering/follow-up |
| `continuation` | Other agent-loop requests, including tool-result continuations |
| `retry` | Automatic retry after a failed request |
| `direct` | Out-of-loop calls, including compaction and extension model calls |

The router receives previous/failed physical models and may return a physical model, thinking level and router state. Throwing or returning an invalid target ends the request with an error. [node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:65-91]

The implementation resolves the virtual target in the agent’s `prepareRequest` callback. It preserves the virtual model in agent state and returns the physical model only for that request. Agent-core then performs the context transformation and starts the stream. Thus, for normal agent requests, routing has already happened when `context` executes, even though `ctx.model` still names the virtual selection. [node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:434-489; node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:128-146,265-280]

### Observable events

| Event/check point | Information available | Pre-send physical-model authorization? |
|---|---|---|
| `input`, `before_agent_start` | Selected model through `ctx.model`; physical routing has not happened | No physical target yet |
| `context`, `context_with_system` | Transcript; `ctx.model` remains the selection | Route has happened, but no physical-target field is supplied |
| `before_provider_headers` | Assembled headers only | No typed provider/model field |
| `before_provider_request` | Opaque serialized payload only | No typed provider/model field |
| `after_provider_response` | HTTP status and headers | Already a response; no provider/model field |
| `provider_stream_event` | Physical `provider`, `api`, `model`, parsed event data | Response-stream observation, not pre-send |
| Assistant `message_start`/`message_end` | Assistant message, which names physical provider/model | Stream/message observation, not a guaranteed pre-send point |

These payloads follow the declarations and SDK forwarding code; the selection/dispatch distinction is explicitly documented. [node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:676-719,836-851; node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:223-252; node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-24]

Assistant `message_start` is emitted when agent-core consumes the provider stream’s `start` event, or a final message if no start occurred. It is **not** emitted as a preflight authorization callback before invoking the stream function. Whether a particular provider emits its start event before or after making its network call is **not settled by this source**; that provider implementation would settle it. [node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:275-341]

A payload may contain a model identifier, but its declared type is `unknown`, and the hook receives no independent physical provider identifier. A reliable, cross-provider mapping from payload to physical account is **not settled by the source**; it would require provider-specific contracts and implementations. [node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:692-705]

### Switchboard-specific observations

Switchboard writes `pi-switchboard.decision` before returning its chosen physical model. Its decision schema is `v: 1` and includes `model.provider`, `model.id`, thinking level, optional account, and switch/error metadata. Decisions are custom session entries, not model-context messages. [packages/pi-switchboard/src/runtime.ts:500-645; packages/pi-switchboard/src/record/types.ts:3-6,33-89]

Another extension can therefore inspect already-written entries through `ctx.sessionManager.getBranch()`. However, this is not a universal “current dispatch” contract: ordinary continuations return `previous` without creating a new decision, and retries that keep the failed model also return without a decision. [node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:112-114; packages/pi-switchboard/src/router/engine.ts:734-752,783-791]

Switchboard’s decision listeners are an internal `Runtime.listeners` set. They are called after appending the decision, with exceptions swallowed; they are not exposed as a `pi.events` routing channel. The documented event-bus integrations are Plannotator queries and usage queries. [packages/pi-switchboard/src/runtime.ts:100-115,500-645; packages/pi-switchboard/DESIGN.md:119-135]

### Can another extension veto or influence the route?

- **No route-veto return contract exists on the listed provider hooks.** Payload hooks transform payloads; header hooks mutate headers; stream hooks notify. Throwing from the payload/header handlers is caught and reported, not propagated as an authorization failure. [node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:692-719; node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:1066-1119]
- An extension can call `ctx.abort()`. Account-guard documents a per-request `context`-plus-abort option, but explicitly says that zero-byte egress after abort is unverified for every transport. It would also need a reliable way to identify the routed target. [node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:643-670; packages/pi-account-guard/DESIGN.md:343-354]
- Usage buckets can influence switchboard’s **next selection** and exclude known-exhausted members. This is cached selection input, not a synchronous veto of the already-chosen request. [packages/pi-switchboard/src/selection/select.ts:84-124; packages/pi-switchboard/src/selection/pi-usage.ts:193-274]

## 2. How failover changes the physical model

### New user requests and continuations

On `user`, switchboard resolves the profile, determines the tier through pinning/classification/rules, and selects a member. Selection may retain a still-eligible previous member according to affinity or strategy granularity. [packages/pi-switchboard/src/router/engine.ts:594-680; packages/pi-switchboard/src/selection/select.ts:127-198]

On `continuation`, it normally returns the previous physical model. Tool-error escalation can instead select a member from a higher tier, record an `escalated` decision and return that physical target. This can change the physical provider within the same user task. [packages/pi-switchboard/src/router/engine.ts:692-752]

### Retry failover

On `retry`, switchboard classifies the failed response, records health/cooldown state, and either keeps the failed physical model or selects a replacement:

- Quota failures bench the provider account.
- Rate limits bench the physical provider/model.
- Auth failures bench the provider account.
- Overloads keep the member until the configured threshold.
- Server failures accumulate within a window before benching.
- Other/context-overflow failures keep the member.

[packages/pi-switchboard/src/router/engine.ts:754-791; packages/pi-switchboard/src/selection/select.ts:220-302]

When switching, switchboard first tries an account sibling if enabled. Otherwise it force-selects another eligible member, excluding the failed member; tier exhaustion can cause borrowing from configured neighbouring tiers. [packages/pi-switchboard/src/router/engine.ts:423-468,793-850]

Account siblings are the base provider and configured `<base>-<n>` aliases. The sibling path checks catalog/auth availability and model/provider cooldowns; it does **not** invoke `selectMember` or the quota callback for the sibling. [packages/pi-switchboard/src/selection/accounts.ts:37-44; packages/pi-switchboard/src/router/engine.ts:461-470,798-812]

### Agent-level versus provider-internal retries

Switchboard participates when Pi re-enters `route()` with `reason: "retry"` after a failed assistant response. Its design deliberately relies on Pi’s agent-level retry rather than adding its own retry loop; provider-level retries are intended to remain at Pi’s default of zero. [packages/pi-switchboard/DESIGN.md:73-78; node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:78-89]

For quota/auth errors Pi would not normally retry, switchboard’s `message_end` handler changes the error text to a retryable “service temporarily unavailable” message when another model can take over. The original error is retained internally for retry classification and decision recording. [packages/pi-switchboard/src/runtime.ts:647-682; packages/pi-switchboard/src/router/engine.ts:341-394]

There is no switchboard route callback inside an individual provider’s internal HTTP retry loop: switchboard supplies the physical target before the stream call. Exact internal-retry behaviour for each provider is **not settled by these inspected sources**; the individual provider implementation and effective retry settings would settle it. [node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:128-146,275-280; node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:193-209]

### Visibility of failover

A physical failover:

- Does **not** change the selected virtual model or its `model_change` entry.
- Does **not** require `pi.setModel` or generate a physical `model_select`.
- Records a `v: 1` custom decision with `reason: "retry"` and kind `failover` or `borrowed`.
- Appears in the resulting assistant message’s physical provider/model.
- Does **not** emit a switchboard routing event on `pi.events`.

[node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-24; packages/pi-switchboard/docs/adr/0002-switchboard-owns-failover-while-routing.md:7-18; packages/pi-switchboard/src/router/engine.ts:798-850; packages/pi-switchboard/src/runtime.ts:500-645; packages/pi-switchboard/DESIGN.md:119-135]

## 3. Usage buckets, selection strategies and cache behaviour

### Bucket calculation

For each applicable bucket, switchboard computes:

```text
limit = bucket.limit, or 100 for a percent bucket

fraction =
    remaining / limit          when remaining is present
    (limit - used) / limit     otherwise, when used is present

fraction is clamped to [0, 1]
```

Missing/non-positive limits or missing measurements produce no usable fraction. `remaining` takes precedence over `used`. [packages/pi-switchboard/src/selection/pi-usage.ts:151-156]

| Bucket feature | Actual behaviour |
|---|---|
| `used >= limit` | Produces zero remaining fraction |
| `unit: "percent"` | Defaults missing limit to 100 |
| `unit: "usd"` or `"count"` | Works with explicit positive limit |
| Several applicable buckets | Smallest remaining fraction wins |
| `modelKeys` absent/empty | Applies to every model of the queried provider |
| Non-empty `modelKeys` | Exact match against the member’s model **id**, not provider/id |
| Unknown measurement | Bucket skipped |
| No usable buckets | No quota returned |
| `windowMinutes` | Parsed and retained; not used in quota calculation or strategies |
| `resetsAt` | Copied from the tightest bucket; does not itself reset usage |
| Equal tightest fractions | First encountered bucket retains its reset metadata |

[packages/pi-switchboard/src/selection/pi-usage.ts:12-23,62-70,151-174]

Percent values therefore follow a **0–100 default-limit convention** in this client, not an implicit 0–1 convention. A service can instead provide an explicit limit, which the same formula uses. [packages/pi-switchboard/src/selection/pi-usage.ts:151-156]

### Exhaustion is an eligibility filter

`selectMember` excludes a member with known `quota.remaining <= 0` as `"budget used up"` **before** affinity/granularity retention and strategy selection. Exhaustion is not merely a low score under `quota-headroom`. Unknown quota passes this check. [packages/pi-switchboard/src/selection/select.ts:84-124,150-198]

Consequently, all strategies using this selection path honour a quota already supplied to it. `quota-headroom` then chooses the largest remaining fraction among eligible members with known data, ties by member order; if none has a metric it uses its configured fallback. `soonest-reset` considers eligible members with a reset and at least 5% remaining, then chooses the earliest reset. A sole eligible member bypasses metric selection. [packages/pi-switchboard/src/selection/strategies.ts:116-134,185-235]

This does **not** mean every strategy requests usage reports. Background querying is restricted to enabled providers appearing in a tier configured with `quota-headroom` or `soonest-reset`. Other tiers can use an existing cached report for that provider, but they do not independently cause it to be fetched. [packages/pi-switchboard/src/selection/pi-usage.ts:278-291; packages/pi-switchboard/src/router/engine.ts:423-448]

### External usage versus switchboard’s own budgets

Runtime quota precedence is:

1. A usable cached usage-service quota, unless `metrics.piUsage` is `"off"`.
2. Otherwise, the member’s configured local ledger budget.
3. Otherwise, unknown quota.

These sources are alternatives, not combined by minimum: a usable external quota wins over a member budget. [packages/pi-switchboard/src/runtime.ts:164-201]

Member ledger budgets are per configured provider/model, use epoch-aligned fixed windows, and derive remaining token/cost fraction from local usage. They are distinct from `src/budgets` soft budgets. [packages/pi-switchboard/src/selection/ledger.ts:96-125]

`BudgetTracker` tracks task/session tokens and estimated cost, reports exceeded limits and deduplicates warnings. Its stated contract is:

> “Routing never changes because of a budget.”

The runtime records and notifies those soft-budget crossings; they do not supply an external usage-service quota. [packages/pi-switchboard/src/budgets/track.ts:15-18,21-65; packages/pi-switchboard/src/runtime.ts:683-716]

### Two services answering one provider

The query emits `{ session, sessionId, providerId, refresh, signal, respond }`. During synchronous event dispatch, the first call to `respond(valueOrPromise)` claims the request. Later calls return `false`, and a first call after dispatch closes also returns `false`. A later service cannot replace the first answer even if that first answer eventually rejects or is malformed. [packages/pi-switchboard/src/selection/pi-usage.ts:89-135]

Thus answers from pi-usage and quota-guard are **not merged**. Handler order matters; Pi documents extension handlers running in load/registration order. [packages/pi-switchboard/src/selection/pi-usage.ts:102-120; node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:193-210]

### Cache freshness and invalidation

The implementation matters more than the design’s “trusted for five minutes” shorthand:

- `quota(member)` returns any stored provider report **without checking `validUntil`**.
- `invalidate()` sets all stored report validity times to zero and clears backoff; it does not delete reports.
- The changed-event listener only calls `invalidate()`; it does not immediately call `refreshFor()`.
- Refreshing is asynchronous, deduplicated per provider, and uses `refresh: true`.
- Ready results replace reports. Non-ready results set backoff—ten minutes for no service, two minutes otherwise—but do not remove old reports.
- `validUntil` controls whether to fetch again, using five minutes and the service expiry; it does not control whether selection may read the old report.

[packages/pi-switchboard/src/selection/pi-usage.ts:213-274; packages/pi-switchboard/src/runtime.ts:410-423]

`resetsAt` is not used to expire or recompute a bucket’s remaining fraction. An exhausted cached bucket remains exhausted until a replacement report changes it. Moreover, the user-route refresh call occurs **after** `engine.route()` completes; a thrown exhaustion error does not reach that call. [packages/pi-switchboard/src/selection/pi-usage.ts:151-174,213-274; packages/pi-switchboard/src/runtime.ts:500-590]

These are important implementation differences from interpreting `usage:changed:v1` or a reset timestamp as an immediate, authoritative unblock. [packages/pi-switchboard/src/runtime.ts:410-423; packages/pi-switchboard/src/selection/pi-usage.ts:213-274]

## 4. External cooldown, health or blocked-provider API

**No documented, versioned external “block this provider/model until time T” contract was found in the inspected switchboard sources.** There is no `docs/api.md`; the documented runtime event-bus integrations are Plannotator and usage queries. Internal cooldown state and functions exist, but are not exposed as an inter-extension authorization API. [packages/pi-switchboard/DESIGN.md:119-135,696-711; packages/pi-switchboard/src/selection/health.ts:10-46; packages/pi-switchboard/src/selection/select.ts:220-302]

The relevant existing **v1** contract is read-only usage:

> “emit `usage:query:v1` with `{ session, sessionId, providerId, refresh, signal, respond }`; the service offers a value or promise through `respond()` before its handler first awaits”

The same documentation specifies remaining/used/limit buckets, optional `modelKeys`, millisecond `resetsAt`, and the tightest applicable bucket. [packages/pi-switchboard/DESIGN.md:707-711]

The source declares the channels explicitly:

```ts
export const QUERY_CHANNEL = "usage:query:v1";
export const CHANGED_CHANNEL = "usage:changed:v1";
```

[packages/pi-switchboard/src/selection/pi-usage.ts:9-10]

A zero-headroom report can therefore influence selection through this existing read-only contract, but it is **not equivalent to a guaranteed immediate cooldown signal**, given cache timing, continuation behaviour and the sibling bypass described above. [packages/pi-switchboard/src/selection/pi-usage.ts:213-274; packages/pi-switchboard/src/router/engine.ts:734-752,798-812]

Whether switchboard will add a synchronous routing authorization API is **not settled by the source**. A new documented versioned contract, its implementation and tests would settle it.

## 5. How pi-account-guard handles this problem

### Virtual models: an explicit accepted limitation

ADR 0004 treats `switchboard/auto` as its own Account and does not resolve its physical member. Its reasoning is that the physical member does not exist at the guard’s turn-start checks, may change on retry, and may be selected anew on the next user turn. Reusing the previous decision would create false confidence. [packages/pi-account-guard/docs/adr/0004-virtual-model-is-its-own-account.md:7-13]

It considers:

- Previous-decision resolution: rejected.
- Static superset check over every possible member: deferred; needs a switchboard API or config reading plus account-source resolution.
- Per-request checking: rejected for that version because the guard intentionally protects turns and selected-model changes, not every provider request.

The user must tag a virtual model only for places in which **every possible member** is allowed; “the real member behind a virtual model is not checked” is a named limitation. [packages/pi-account-guard/docs/adr/0004-virtual-model-is-its-own-account.md:9-19; packages/pi-account-guard/DESIGN.md:330-361]

### Mid-turn failover that emits `model_select`

When a selected model changes during a running turn, account-guard:

1. Evaluates live `ctx.model`, not potentially stale `event.model`.
2. Returns without aborting if Pi is idle.
3. Aborts a running turn if the new model is blocked.
4. Releases Allow once, logs `guard.block`, and notifies.
5. Waits for `agent_settled` before showing the recovery dialog.

[packages/pi-account-guard/src/pi/model-guard.ts:63-112]

That dialog offers switching and session allowance, but no Allow once; it prefers the previous account when available. It never resumes the aborted turn automatically. [packages/pi-account-guard/src/pi/mid-turn-block.ts:25-65; packages/pi-account-guard/src/core/mid-turn.ts:24-43]

This protects model changes performed through selection mechanisms such as `pi.setModel`. It does **not** catch switchboard’s physical failover, because the virtual selection remains unchanged. Account-guard explicitly lists eventless virtual rerouting among its unguarded cases. [packages/pi-account-guard/DESIGN.md:323-354; node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-24]

### `before_agent_start` re-check

Account-guard re-evaluates every run start, including idle custom messages started with `pi.sendMessage(..., { triggerTurn: true })`. On a block it aborts, releases Allow once and records/notifies the block. This catches an idle-time selection change after `input` allowed. It still evaluates the **selected** model, so it does not solve virtual dispatch identification. [packages/pi-account-guard/src/pi/model-guard.ts:114-128; packages/pi-account-guard/DESIGN.md:151-169,330-343]

## 6. What footer/status extensions see

While a virtual model is selected:

- `ctx.model` and `ctx.thinkingLevel` describe the **virtual selection**.
- Assistant messages—including those observed at `message_end`—record the **physical** `provider`, `api`, `model` and thinking level.
- Physical rerouting does not require a new `model_select`.
- Pi’s built-in interactive footer can show both pairs, but that does not change the extension context contract.

[node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-28; node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:847-851]

Switchboard itself uses the assistant message’s provider/model for usage accounting and its last decision for footer rendering. It does not infer dispatched usage from `ctx.model.provider`. [packages/pi-switchboard/src/runtime.ts:647-738]

For a quota footer, response-header attribution has an additional limitation: `after_provider_response` contains only status and headers, while the SDK attaches physical identity to `provider_stream_event`, not to the response event. A generic physical-provider correlation API for response headers is **not settled by the source**; a new correlation contract or provider-specific integration would settle it. [node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:230-252; node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:706-719]

## Implications for pi-quota-guard

| Enforcement option | Mechanically possible now? | Requirements and limits established by the source |
|---|---|---|
| Gate the selected physical provider in `input` | Yes, when selection is physical | Does not identify switchboard’s future target; virtual selection and dispatch are separate. [node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-24,65-89] |
| Publish Budget buckets through `usage:query:v1` | Yes | Supply positive limits and measurements in the declared units; publish equivalent shared-account headroom for each queried provider. Switchboard takes each provider’s tightest applicable bucket. [packages/pi-switchboard/src/selection/pi-usage.ts:12-23,151-174,213-216] |
| Treat those buckets as complete hard enforcement | No | Cached/asynchronous reads, unchanged continuations, and sibling failover bypass prevent that guarantee. [packages/pi-switchboard/src/selection/pi-usage.ts:213-274; packages/pi-switchboard/src/router/engine.ts:734-752,798-812] |
| Use `usage:changed:v1` for immediate blocking/unblocking | No, not with current implementation | It only marks reports stale; it neither replaces data nor immediately fetches. Reset times do not clear exhaustion. [packages/pi-switchboard/src/runtime.ts:410-423; packages/pi-switchboard/src/selection/pi-usage.ts:151-174,219-223] |
| Abort when a physical `model_select` becomes blocked | Yes | Covers actual selection changes, not switchboard dispatch changes; account-guard supplies the abort/settlement pattern. [packages/pi-account-guard/src/pi/model-guard.ts:63-128] |
| Gate every request after routing | Possible abort mechanism, incomplete target contract | `context` runs after routing, but does not expose the dispatched target. Needs a reliable physical-target contract and transport-specific verification that abort prevents egress. [node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:128-146,265-280; packages/pi-account-guard/DESIGN.md:354] |
| Reject disallowed candidates inside switchboard routing | Not available through an existing external veto API | Would need a documented versioned integration covering normal selection, sibling failover, continuations and direct fallbacks—not just quota ranking. [packages/pi-switchboard/src/router/engine.ts:423-470,734-880] |
| Conservatively gate all possible members at turn start | No ready-made member-enumeration API established here | Account-guard identifies this as a separate integration requiring a router API/config enumeration and account resolution. [packages/pi-account-guard/docs/adr/0004-virtual-model-is-its-own-account.md:11-13] |
| Account usage and display after dispatch | Yes | Use assistant `message_end` physical provider/model; keep virtual selection separate in UI and header attribution. [packages/pi-switchboard/src/runtime.ts:647-738; node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md:17-24] |

An important policy consequence is already mechanical: publishing an exhausted Budget as a usage bucket affects **selection on retry or escalation**, not only the next user prompt. That differs from a strict “the allowed running turn finishes, including failover” policy unless the integration supplies turn-aware allowance semantics. The existing usage request carries session identity but no turn-allowance field. [packages/pi-switchboard/src/selection/pi-usage.ts:102-115; packages/pi-switchboard/src/router/engine.ts:704-708,813-815; packages/pi-switchboard/src/selection/select.ts:84-104]

## Sources

Primary sources inspected; installed Pi identifies itself as **1.4.0**. [node_modules/@earendil-works/pi-coding-agent/package.json:1-3]

- Routing and records: `packages/pi-switchboard/src/router/engine.ts`, `src/runtime.ts`, `src/index.ts`, `src/record/types.ts`; design and ADR 0002. [packages/pi-switchboard/src/index.ts:21-28; packages/pi-switchboard/docs/adr/0002-switchboard-owns-failover-while-routing.md:7-18]
- Usage, selection and budgets: `packages/pi-switchboard/src/selection/{pi-usage,select,strategies,ledger,health,accounts}.ts`, `src/budgets/track.ts`; `docs/strategies-and-failover.md`. [packages/pi-switchboard/docs/strategies-and-failover.md:5-58]
- Pi contracts and implementation: `docs/virtual-models.md`, `docs/extensions.md`, `dist/core/{sdk,agent-session,model-runtime}.js`, `dist/core/extensions/{types.d.ts,runner.js}`; agent-core’s `dist/agent-loop.js`. [node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:94-125,176-191]
- Account-guard policy and implementation: `DESIGN.md`, ADR 0004, `src/pi/model-guard.ts`, `src/pi/mid-turn-block.ts`, `src/core/mid-turn.ts`. [packages/pi-account-guard/DESIGN.md:330-354; packages/pi-account-guard/docs/adr/0004-virtual-model-is-its-own-account.md:7-19]

The earlier `/tmp/wf-quota/prior-switchboard-routing.md` note was used only as a checklist, not as evidence. In particular, its previously unverified pre-send event question is resolved above from Pi’s declarations and forwarding implementation. [node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:692-719; node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:223-252]
