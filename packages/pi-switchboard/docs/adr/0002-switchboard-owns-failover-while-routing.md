---
status: accepted
---

# pi-switchboard owns failover while its virtual model is selected

pi-multi-pass reacts to rate-limit errors in `agent_end` by calling `pi.setModel` on the next account of the *selected* model's provider. While `switchboard/auto` is selected, that provider is not in any multi-pass pool, so multi-pass does nothing. Rather than trying to coordinate with it, pi-switchboard handles failover itself inside `route()` on `retry`: it moves to the next healthy member of the same tier, or, only when `accountSiblings` is enabled, to the same model on another account of the same base provider (read from `multi-pass.json`, never written). If anything selects a physical model with `pi.setModel`, routing stops and the footer says so; selecting the virtual model again resumes it. This guarantees exactly one owner per failure.

## Considered options

- **Delegate to multi-pass.** Re-select the virtual model after a multi-pass `model_select`. Fragile, because multi-pass never fires while the virtual model is selected, and racing two extensions over `pi.setModel` is the failure mode the spec forbids.
- **Never cross accounts.** Safe for terms of service, but a rate limit on one subscription then drops straight to another member or the fallback tier.

## Consequences

- `accountRotation: delegate | self` from the original spec becomes `accountSiblings: off | on`, off by default, with a one-time terms-of-service warning when turned on.
- multi-pass keeps working unchanged whenever the user leaves the virtual model.
