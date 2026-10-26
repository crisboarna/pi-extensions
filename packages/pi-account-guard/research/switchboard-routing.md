# Can the guard resolve a virtual routing model to its real member account?

Research for wayfinder ticket 11 (throwaway branch, never merged). Sources: pi docs `virtual-models.md` and `extensions.md` (pi-bolt install, `~/.pi-bolt/pi-bolt-darwin-arm64/docs/`), pi-switchboard `DESIGN.md`, `src/runtime.ts`, `src/router/engine.ts`, `src/record/types.ts`, `docs/adr/0002-*.md` (repo `~/Projects/pi/pi-switchboard`).

## Conclusion

Not resolvable before send at the guard's check points. Keep the v1 frame (the virtual model is its own Account) and name the hazard in the spec. A pre-send member check needs a gate on every request, which ticket 10 ruled out. An optional later step is a static check of all possible members.

## Findings

1. **The member is chosen by pi calling `route()` before every request, not at turn start.** `route(request, ctx)` "runs before every request made with the virtual model" (`virtual-models.md`, "Route requests"). `request.reason` is `user`, `continuation`, `retry` or `direct`. switchboard registers its virtual models with `route: (request, ctx) => this.route(id, request, ctx)` (`src/runtime.ts:177-188`) and `Runtime.route` is at `src/runtime.ts:440`.
2. **The turn-start check points run earlier than `route()`.** `input` and `before_agent_start` fire before the model request; the request runs `context`, `context_with_system`, `before_provider_headers`, `before_provider_request`, `after_provider_response` in that order (`extensions.md`, "The model request runs these hooks in order"). At the guard's check points no member has been chosen for the turn yet.
3. **What the guard sees is the virtual selection.** pi keeps selection and dispatch apart: `ctx.model`, `model_change` entries and `/model` show the virtual model; each assistant message records the physical `provider`/`model` (`virtual-models.md`, "Selection and dispatch"). So `ctx.model` at `input` is `switchboard/auto`, a provider id that no real provider uses.
4. **The decision is recorded, but after it is made.** `Runtime.record` calls `pi.appendEntry(DECISION_TYPE, decision)` (`src/runtime.ts:497`) with `model: { provider, id, thinking, account?, subscription? }` (`src/record/types.ts`, `DecisionEntry.model`); `account` is the multi-pass sibling provider when `accountSiblings` is on (`src/router/engine.ts:424`). The entry is a custom session entry (`pi-switchboard.decision`), readable through `ctx.sessionManager.getBranch()` once `route()` has run.
5. **No pre-send event for other extensions.** The only `pi.events.emit` calls in switchboard are requests to Plannotator and pi-usage (`src/router/pi-glue.ts:74`, `src/selection/pi-usage.ts:109`). Its decision `listeners` (`src/runtime.ts:88`) are an in-process set for its own UI, not on `pi.events`.
6. **The member can change mid-turn.** `continuation` returns `previous`, but `retry` can bench the failed member and move to another member of the tier, or an account sibling (`DESIGN.md` section 4 "Per request reason", ADR 0002). Quota errors are rewritten in `message_end` so pi retries and re-enters `route()` (`DESIGN.md` 4.4). A check at turn start therefore cannot bind the account that finally sends.
7. **A new user turn re-classifies.** On `reason: "user"` the tier and member are chosen afresh (`DESIGN.md` 4, 4.1), so the previous turn's decision entry is not a reliable prediction either.
8. **Members can span zones.** A tier lists members of any provider (`DESIGN.md` 7.1), so tagging `switchboard/auto` with one zone says nothing about the accounts it routes to.

## Options

| Option | Effect | Cost |
|---|---|---|
| A. Keep v1: tag the virtual model as an Account (recommended for v1) | Match uses the zones the user tags on `switchboard/auto`. | Guard cannot see the real member; user must tag it only with zones in which every possible member is allowed. Document in the spec. |
| B. Static superset check (later) | Guard reads the selected profile's possible members (from `pi-switchboard.json` or an exported API) and requires every member's Account to Match; unknown member means Block. No per-request gate. | Couples the guard to switchboard's config or needs a new switchboard API; the guard must resolve each member's auth source. |
| C. Per-request check in `before_provider_request` / `context` | Binds the real member at send time. | Contradicts ticket 10 (no per-request gate); the physical model may not be visible there. Not verified. |
| D. Post-send detection in `message_end` | Names the real account after the fact and aborts the next turn. | Detects after the request already went out. |

## Other virtual or pooled providers (one line each)

- pi-multiprovider pools: leased in-stream, no event (ticket 3); same blind spot, already a known limit via ADR 0002.
- pi-multi-pass: rotates with `pi.setModel`, so `model_select` fires with the physical account and the guard sees it (ticket 4).
- claude-bridge: a physical provider id with its own auth source (ADR 0002); not a router.

## Open uncertainties

- Whether `before_provider_request` payloads expose the dispatched physical model (not checked; only matters for option C).
- Whether switchboard would add a read-only API or `pi.events` channel listing a profile's possible members (needed for option B).
- The delegate agent for this ticket failed twice (extension provider not loadable in the child), so this was researched directly in the main session.
