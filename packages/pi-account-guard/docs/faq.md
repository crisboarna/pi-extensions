# FAQ

## Is it a security boundary?

No. It is a guard against slips: using a work subscription in a personal repository, or the other way round, by accident. Anyone who can edit `account-guard.json` or start pi with another extension can get around it. It never reads secrets.

## Why does it block when it cannot decide?

Letting a turn through when the config is broken or git fails would send exactly the turn the guard exists to stop. The block names the cause and the fix. See [ADR 0001](adr/0001-fail-closed-when-undecidable.md).

## Why is the same provider sometimes two accounts?

An account is a provider id plus its auth source. A provider signed in with OAuth and the same provider through an environment key can be two different subscriptions, so each gets its own tag. See [ADR 0002](adr/0002-account-is-provider-id-plus-auth-source.md).

## Why is there no project-level config file?

A place's zone is your statement about your own disk and your own accounts. A file committed to a repository travels to other clones, machines and people, where that statement may be wrong, and it would need a precedence rule against your own rules. One file in the agent directory holds every tag and rule. See [ADR 0003](adr/0003-one-global-config-file.md).

## How does it work with a router such as pi-switchboard?

`switchboard/auto` is one account, tagged like any other. Tag it only with zones in which every model it can pick is allowed; the member it picks is not checked. See [with other extensions](with-other-extensions.md) and [ADR 0004](adr/0004-virtual-model-is-its-own-account.md).

## And with pi-multi-pass rotation?

A rotation is a model change. During a turn into an account of the wrong zone, the guard aborts the turn, then offers the previous account first. Rotation inside one zone never blocks.

## Can a script run with untagged accounts?

Set `PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1` for that process. It lets untagged accounts through in print, JSON and RPC mode, never a tagged account of the wrong zone, and the TUI ignores it. See [headless use](headless.md).

## Why exit code 77?

So a script can tell a guard block from a model error (exit code 1). See [ADR 0005](adr/0005-exit-code-77-for-headless-blocks.md).

## Does it write anything?

Only `account-guard.json`, and only when you tag an account or edit rules and zones through `/guard`. It writes atomically and never over a malformed file. Overrides are never written. The one other file is `account-guard.first-run` next to it, which remembers that the first-run notice was shown.
