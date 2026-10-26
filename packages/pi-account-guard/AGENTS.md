# pi-account-guard

Stops a pi session from sending a user turn to a model account that does not belong to the zone of the directory the session works in. These rules add to the repository `AGENTS.md`.

## Read first

- `GLOSSARY.md` defines account, auth source, zone, place, place rule, Match, Block, Override and the other terms; use them exactly, and add a term there before using a new one.
- `DESIGN.md` is the design of record (configuration in section 4, account identity in 6, enforcement points in 8, Block behaviour in 9, testing in 17); update it in the same change as behaviour it describes. Section 18 lists the decisions and the accepted deviations.
- `docs/adr/` holds the decisions that are expensive to reverse; add an ADR instead of reversing one silently.
- `docs/history-import.md` maps the commits and issues imported from the old `crisboarna/pi-account-guard` repository.

## Invariants

- The guard fails closed: when it cannot decide (bad config, git failure, unknown auth source), it blocks the turn (ADR 0001).
- An account is a provider id plus its auth source (ADR 0002); the same provider id on another auth source is another account.
- One global config file, `account-guard.json` in the pi agent directory; there is no project-level file (ADR 0003).
- Headless Blocks exit with code 77 (ADR 0005).
- The source names no real provider, model or account; `test/unit/source-scan.test.ts` enforces it.
- `src/core/` is pure and imports nothing from pi; `test/unit/core-purity.test.ts` enforces it.
- The guard never reads secrets or `auth.json`; it reads only which auth source pi would use.

## Code map

- `src/index.ts` is the extension factory; `src/pi/hooks.ts` wires pi events to the guard.
- `src/core/` holds the pure logic: config parsing and writing, place resolution and globs, account identity, the Match decision, overrides and the text of every dialog, footer and message.
- `src/pi/` adapts the core to pi: the input gate, the model guard, the interactive Block, the tag prompt, `/guard` commands, git and the file system.

## Testing

- Unit tests (`test/unit/`) cover the pure core.
- Integration tests (`test/integration/`) load the extension through jiti against the fake host in `test/support/fake-pi.ts`, with `PI_CODING_AGENT_DIR` in a temporary directory.
- Smoke tests (`npm run test:smoke`, opt-in) drive the real `pi` on `PATH` offline with `test/support/stub-provider.ts`; they are not part of `npm test` or CI.
- `docs/manual-checklist.md` lists the checks that need a real TUI; record results there and remove an entry from the README's limitations only after running it.
