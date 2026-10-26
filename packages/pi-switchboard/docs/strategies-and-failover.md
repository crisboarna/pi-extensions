# Strategies, failover and quota

A tier holds one or more **members** (models, with an optional thinking level), from any provider or account. The tier's **strategy** picks one member for the request; health tracking keeps failing members out of the way.

## Strategies

Set per tier (`"strategy": "round-robin"` or `{ "name": "round-robin", "granularity": "session", "fallback": "ordered" }`) or per profile as the default. Ties always break by list order.

| Strategy | Picks | When its data is missing |
|---|---|---|
| `ordered` | the first healthy member | n/a |
| `sticky` (default) | the member that last served this session | `ordered` |
| `round-robin` | the next member after a shared pointer; granularity `session` (default), `task` or `request` | random start |
| `weighted` | smooth weighted round robin by `weight` | weighted random |
| `random` | uniform, or weighted by `weight` | n/a |
| `least-recently-used` | the member idle longest | never-used members first |
| `least-in-flight` | the fewest requests running, counting parallel subagents | `ordered` |
| `quota-headroom` | the most allowance left (pi-usage, or a member `budget`) | `fallback` |
| `soonest-reset` | the earliest reset among members with at least 5% left | `fallback` |
| `cheapest` | the lowest catalog price (input and output weighted 3:1) | unknown prices last |
| `largest-context` | the largest context window | unknown last |
| `fastest` | the lowest time to first token | `ordered` until each member has 3 samples |
| `subscription-preferred` | members on a subscription login first | n/a |
| `scheduled` | members inside their `schedule` windows (`{ "days": "mon-fri", "from": "09:00", "to": "18:00" }`) | `fallback` |
| `custom` | `select(members, context)` from your own module (absolute or `~/` path) | `fallback` on error |

Per-member settings apply with any strategy, in order: `enabled`, cooldown, `maxConcurrency`, affinity (`tier.affinity.scope`: keep the member for the `session` or `task`), then the strategy. Members are chosen only on a new user turn, at subagent launch, on escalation, and on a retry that calls for failover, so a healthy member is not swapped mid-task.

Round-robin pointers, in-flight requests, cooldowns and latency are shared through `~/.pi/agent/pi-switchboard/health.json` by every pi process and subagent on the machine.

## Failover

pi reports provider errors as text, so pi-switchboard classifies them by pattern (override with `failover.errorClasses`):

| Error | Examples | What happens | Default bench |
|---|---|---|---|
| usage limit | `usage limit`, `quota`, `insufficient_quota` | the whole provider account sits out; the next member runs | until the reset the error names, else 60 min |
| rate limit | `rate limit`, `too many requests`, `429` | the model sits out; the next member runs | `retry-after`, else the tier's `cooldown.defaultMs` (5 min) |
| overloaded | `overloaded`, `capacity`, `503`, `529` | retry the same member, switch after `failover.overloadSwitchAfter` (2) | none |
| auth | `401`, `403`, `invalid api key` | the next member runs | 60 min |
| context overflow | `context length`, `prompt is too long` | keep the member (pi compacts) | none |
| server | `5xx`, `timeout`, `ECONNRESET` | keep; after 3 in 60 s, bench and switch | 60 s |

pi does not retry a usage-limit error by itself, so pi-switchboard rewrites that error's text into a retryable one when another member can take over; the original error stays in the decision record. With `failover.accountSiblings: "on"`, the same model on another account of the same provider (from pi-multi-pass) is tried first.

## When a whole tier is cooling down

1. **Borrow** from the nearest tier above with a healthy member, then below (`exhaustion.borrow`). Subagents borrow only within their limits. The decision says `borrowed`, and the footer marks the tier.
2. If every tier is out, the request fails with the earliest reset: `pi-switchboard: every model is cooling down; earliest reset 14:05 on <member>`. No provider request is made.
3. With `exhaustion.autoContinue: true` (off by default), pi-switchboard sends `continue` at that reset, waiting at most `maxWaitMs` (6 h). `/tier resume cancel` stops it. This is the only time pi-switchboard sends a message for you.

## Quota

`quota-headroom` and `soonest-reset` read how much allowance an account has left from [pi-usage](https://www.npmjs.com/package/@narumitw/pi-usage) when it is installed (its `usage:query:v1` protocol, refreshed in the background and only for providers these strategies use). Otherwise they use a member's own `budget` (`{ "window": "5h", "tokens": 2000000 }`) against the local usage ledger. With neither, the strategy's `fallback` chooses. A ChatGPT Business account reports no allowance windows, so it always takes the fallback.

## Budgets

Soft budgets on tokens and estimated cost, per task and per session, set globally (`budgets`) or per profile. Crossing one notifies once and marks the footer; routing never changes because of a budget. `/tier budget` shows spend against each.
