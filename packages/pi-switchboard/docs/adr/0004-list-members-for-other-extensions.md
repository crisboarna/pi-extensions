---
status: accepted
---

# List the models behind each virtual model on pi's event bus

pi-account-guard checks that a model's account belongs to the zone of the directory, at the start of each turn. Behind `switchboard/auto` no member has been chosen yet at that point, and failover can move a turn to another account later, so the guard could not see where a turn would go. pi-switchboard therefore answers `switchboard:members:v1` on pi's event bus: a request `{ provider, id, respond }` for one of its own virtual models gets `{ members: [{ provider, id }] }`, every physical model that model can route to. Any extension may ask; pi-switchboard reads nothing back.

## Decisions

- **A superset, not a prediction**: every enabled member of the model's profile (of every profile for the auto model), across all tiers because a turn may borrow another, plus the account siblings that `failover.accountSiblings` or `subagents.accountAffinity: "parent"` can move a member to. Members with `enabled: false` are never routed, so they are left out.
- **Answered during `emit`**, from the live config, so it holds the config of the moment.
- **A failure is answered as `{ error }`, never thrown.** pi's bus swallows a throwing handler, and the asker would read silence as "no router".
- **Silent** for a physical model, another provider's model, or while pi-switchboard is blocked by a conflicting router. It stops answering at `session_shutdown`.
- **Versioned in the channel name.** A change to the request or the answer gets a new channel; v1 stays answered while any released pi-account-guard asks for it.

## Considered options

- **Emit the chosen member before each request.** Exact, but the asker could only act mid-turn, after the classifier has seen the prompt.
- **Let other extensions read pi-switchboard's config.** Its file format is private and changes; the event is the documented contract.

## Consequences

- The answer can name members that a given turn would never reach, so a cautious asker may refuse a turn that would have been fine. That is the asker's choice; pi-account-guard documents it.
