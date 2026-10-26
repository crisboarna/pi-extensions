---
status: accepted
---

# Headless Blocks exit with code 77

When a Block happens in print or JSON mode, the guard writes its message to stderr and sets `process.exitCode = 77`. pi does not fail by itself here: a handled `input` exits 0 with no output, which a script would read as success. A distinct code lets a script tell a guard Block from a model or network error (exit 1). The code is a contract that scripts will depend on, so changing it later costs more than most choices in this design.

## Considered options

- **Exit code 1.** Rejected: indistinguishable from any other failure, so a script cannot react to "wrong account for this directory" differently from "provider down".
- **Print the message on stdout.** Rejected: it would pollute piped output.

## Consequences

- Smoke tests must prove that `process.exitCode = 77` survives `pi -p`. If it does not, the design needs another mechanism before more code exists.
- RPC has no exit code: a handled prompt returns success with `disposition: "handled"` and the message arrives as a `notify` request.
