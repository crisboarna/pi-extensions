---
status: accepted
---

# Check every member a router lists behind a virtual model

ADR 0004 made a virtual model such as `switchboard/auto` its own Account, because at the guard's check points no member has been chosen yet. That let pi-switchboard's failover move a turn to an account in another zone without the guard seeing it, and cross-account failover is pi-switchboard's main feature. This supersedes ADR 0004 for routers that list their members.

At every check, the guard asks on pi's event bus, `switchboard:members:v1`, for the physical models behind the selected model: it emits `{ provider, id, respond }`, and the router that owns the model calls `respond` during `emit` with `{ members: [{ provider, id }] }` or `{ error }`. The guard then checks the Account of every member, and the turn is a Match only when each one matches the place. This is the static superset check that ADR 0004 deferred: it binds no member at send time, so it needs no per-request hook, and it cannot be fooled by a retry or a re-classification because every model the router could pick is checked before the turn starts.

## Decisions

- **No answer** (no router installed, or one that does not support the channel): the virtual model is its own Account, as in ADR 0004.
- **An `{ error }`, an answer of the wrong shape, an empty list, or a member pi does not list**: Block (ADR 0001). The Block is on the virtual model's own Account, so its Overrides still let the user through.
- **A member that does not match** is the Account the Block names, so the tag prompt, the Block dialog and the Overrides work on the real Account (`acme (oauth)`), not on the virtual model.
- **Overrides are checked member by member**: one that covers an earlier member does not hide a later member that nothing covers.
- **An answer after `emit` returns** is ignored.

## Considered options

- **A per-request check in `before_provider_request` on the chosen member.** Exact, but it Blocks mid-turn on a failover and contradicts guarding only user-started turns and model changes.
- **Read the router's config file.** Ties the guard to another extension's private files, which the repository's package boundaries forbid.

## Consequences

- With pi-switchboard, users tag the accounts of the members, not `switchboard (env:virtual)`; the virtual model's own tag is used only when no router answers.
- A tier with a member in another zone now Blocks every turn on that virtual model in this place, even when the member that would be picked is in the right zone. The Block names the member, so the fix is to tag it, remove it from the profile, or pick a narrower virtual model.
- The footer and `/guard check` still describe the virtual model's own Account.
