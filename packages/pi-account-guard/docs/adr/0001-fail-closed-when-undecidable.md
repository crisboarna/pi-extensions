---
status: accepted
---

# The guard fails closed when it cannot decide

When the guard cannot make a Match decision (no valid config in this session, a Place whose zone depends on a git remote that could not be read, or an unexpected error in its own handlers), it blocks the turn and names the cause, instead of letting the turn through with a warning. The guard exists to stop an accident that happens silently; failing open would let that accident through exactly when something is broken, which is when nobody is watching. Allow-once and session overrides stay available on every such Block, so a broken config or a missing git binary never locks the user out of pi.

## Considered options

- **Fail open with a warning.** What pi-multi-pass 1.12.0 does for its `allowedSubs` restriction when the project file is missing or malformed. Rejected: a warning scrolls past, and the request has already gone to the wrong account.
- **Fail closed without overrides.** Rejected: a typo in `account-guard.json` would stop all work until fixed.

## Consequences

- Every guard handler must catch its own errors and abort the turn itself, because pi swallows hook errors and continues, which would otherwise make every bug fail open.
- A missing config is not undecidable: it is an empty config, so the first turn shows the tag prompt for an Unknown account.
- A malformed config falls back to the last valid copy read in the session; only with no valid copy does every turn block. The guard never writes over a malformed file.
