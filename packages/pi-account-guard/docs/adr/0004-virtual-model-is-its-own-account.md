---
status: accepted
---

# A virtual routing model is its own Account in v1

The guard treats a virtual model such as `switchboard/auto` as one Account, tagged like any other, and does not try to resolve the real member account behind it. pi calls the router's `route()` before every request, after the `input` and `before_agent_start` hooks where the guard checks, so at the guard's check points no member has been chosen yet and `ctx.model` is the virtual model. The member can also change on a retry and is chosen again on every new user turn. Predicting it at turn start would give a false sense of safety.

## Considered options

- **Resolve the member at check time from the router's last decision.** Rejected: the decision is only written inside `route()`, switchboard emits no event for other extensions, and the next turn re-classifies.
- **A static superset check: every possible member of the selected profile must Match.** Sound without a per-request gate, but it needs a switchboard API or a read of its config, and the guard would have to resolve each member's auth source. Deferred, not rejected: it would be a new effort.
- **A per-request check in `context` or `before_provider_request`.** Binds the real member at send time, but contradicts the decision to guard only user-started turns and model changes.

## Consequences

- The user must tag a virtual model only with zones in which every possible member is allowed. The spec says so in the tag prompt text and in DESIGN.md.
- "The real member behind a virtual model is not checked" is a named known limit.
