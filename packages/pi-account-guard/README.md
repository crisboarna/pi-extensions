# pi-account-guard

A pi extension that stops a session from sending a user turn to a model account that does not belong to the zone of the directory the session works in. See `DESIGN.md` for the design, `GLOSSARY.md` for the vocabulary and `docs/adr/` for the decisions.

Status: the first guard behaviour is in. A turn whose account does not match the place zone is blocked in headless mode (message on stderr, exit code 77). Configuration is read from `account-guard.json` in the pi agent directory; the TUI dialogs, remote rules and `/guard` commands are not built yet.

## Development

Requires Node 22.19 or later and an installed pi release.

```sh
npm run link:pi          # link the host packages from the installed pi release
npm run typecheck        # tsc --noEmit, strict
npm test                 # unit tests on the pure core (src/core)
npm run test:integration # fake-pi host loading src/index.ts through jiti
npm run test:smoke       # opt-in: real pi, offline, with the stub provider
```

The smoke tests run the `pi` on `PATH` (override with `PI_BIN`) with `PI_OFFLINE=1`, an empty agent directory and credential environment variables removed. `test/support/stub-provider.ts` answers every prompt locally.
