# @crisboarna/pi-account-guard

[![npm](https://img.shields.io/npm/v/@crisboarna/pi-account-guard)](https://www.npmjs.com/package/@crisboarna/pi-account-guard) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D22.19-green)](package.json)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-account-guard/media/banner-dark.png">
  <img alt="pi-account-guard: a keyed plug seated in the personal jack with its lamp lit green, while the work jack stays dark. Rotate freely. Never into the wrong zone." src="https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-account-guard/media/banner-light.png" width="1100">
</picture>

Keeps each [pi](https://pi.dev) session on the accounts that belong where it runs: a work subscription never answers in a personal repository, and the other way round. Before each turn, the guard checks the account pi is about to use against the zone of the directory, and when they differ it blocks the turn and offers the fix in one keystroke. It is for anyone with work and personal subscriptions in one pi, especially with rotators and routers that change accounts on their own.

![In ~/personal/garden-planner with the work account acme selected, the prompt is blocked: "BLOCKED acme (env:ACME_WORK_KEY) is zone work, Place ~/personal/garden-planner -> zone personal", with Switch to homelab, Allow once, Allow for session and Cancel](https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-account-guard/media/check-1-2-1-block.png)

It is a guard against slips, not a security boundary: it never reads secrets, and when it cannot decide, it blocks.

## Install

```bash
pi install npm:@crisboarna/pi-account-guard
```

Restart pi. Requires Node 22.19 or later; checked with pi 1.4.

## Quick start

With no config the guard knows two zones, `work` and `personal`, and every directory is `personal`.

1. In a work repository, run `/guard place add here zone=work`. This directory and everything below it are now `work`. For every repository of an organization, use its remote instead: `/guard place add remote=*/acme-corp/* zone=work`.
2. Send a prompt. The first time an account is used, the tag prompt asks which zones it belongs to. Tick `work`, and the turn goes at once.
3. Open a personal repository with the same account selected. The turn is blocked, and the select offers Switch rows for the accounts you tagged `personal`.
4. Run `/guard` at any time: it shows the place and the rule that decides it, the account and whether it matches.

The footer shows the result as you work: `guard personal ✓`, or `guard personal ✗ acme is work` before a turn would be blocked.

## What you get

- **Fails closed.** An untagged account, a broken config or a git failure blocks the turn and says why, instead of letting it through.
- **One-keystroke fix.** The block offers Switch to an account of this zone, Allow once, Allow for session, or Cancel, which puts your prompt back.
- **Tags itself on first use.** No config to write up front: each new account asks for its zones once.
- **Catches rotators and routers mid-turn.** A model change into the wrong zone during a turn (pi-multi-pass rotation, `/model`, a router fallback) aborts the turn and offers the previous account first.
- **Scripts can tell.** In print and JSON mode a block exits with code 77, with the reason on stderr.
- **Reads no secrets.** An account is a provider id plus its auth source, such as `env:ACME_WORK_KEY` or `oauth`, never the key itself.

## Configuration

One file, `~/.pi/agent/account-guard.json`, edited by `/guard` or by hand. The settings most people change:

| Setting | Effect | Default |
|---|---|---|
| `zones` | Every zone a tag or rule may name | `["work", "personal"]` |
| `defaultZone` | The zone of a directory no rule matches | `personal` |
| `accounts` | Tags: `provider`, `source` and its `zones` | none, so every account is untagged |
| `places` | Place rules by `path`, git `remote` or both; the first match wins | none |

The full format, validation and the JSON Schema are in [configuration](docs/configuration.md).

## Reference

- [Configuration](docs/configuration.md): the file, zones, accounts, place rules, validation and the JSON Schema.
- [Blocks](docs/blocks.md): the select, the tag prompt, and a model change during a turn.
- [Commands](docs/commands.md): every `/guard` command.
- [Footer](docs/footer.md): every footer text, and pi-powerline-footer.
- [Headless use](docs/headless.md): exit code 77, the process override and RPC.
- [With other extensions](docs/with-other-extensions.md): claude-bridge, pi-multi-pass, pooled providers and pi-switchboard.
- [Troubleshooting](docs/troubleshooting.md) and [FAQ](docs/faq.md).
- [DESIGN.md](DESIGN.md), [GLOSSARY.md](GLOSSARY.md) and the [decision records](docs/adr/).

## Limitations

The guard checks the account pi is about to use at the moments below. It does not watch every request.

Not guarded in v1:

- `pi.sendMessage` turns while streaming, and extension `/commands` that start work.
- Retries and virtual-model re-routing that change the physical model without an event.
- Out-of-loop model changes (RPC `set_model`, the TUI selector) racing a running turn.
- Cache warmer keep-alive requests.
- Compaction and branch summaries.
- Subagent child processes and other extensions' own HTTP clients.

Known gaps in account identity, because detecting them needs secrets:

- Re-login into the same provider id as a different human account, a direnv-swapped key under the same variable name, and an `auth.json` edit made outside pi (seen one refresh late).
- A claude-bridge credential defined only in the `env` block of Claude Code's own `settings.json`.
- Pooled providers: the guard only warns.
- The real member behind a virtual model.

Also: the place zone is cached at session start (a hand edit of `places` or a remote change needs `/reload`), and a rule written against a symlink alias of a directory does not match. See [DESIGN.md](DESIGN.md) sections 14 and 15.

## Development

The package lives in the [pi-extensions](https://github.com/crisboarna/pi-extensions) monorepo. Run `npm install` and `npm run check` from the repository root; the root supplies the pi host packages and the tooling.

```sh
npm test --workspace @crisboarna/pi-account-guard                  # unit tests on the pure core (src/core)
npm run test:integration --workspace @crisboarna/pi-account-guard  # fake-pi host loading src/index.ts through jiti
npm run test:smoke --workspace @crisboarna/pi-account-guard        # opt-in: real pi, offline, with the stub provider
```

The smoke tests run the `pi` on `PATH` (override with `PI_BIN`) with `PI_OFFLINE=1`, an empty agent directory and credential environment variables removed. `test/support/stub-provider.ts` answers every prompt locally. The checks that need a real TUI are in [docs/manual-checklist.md](docs/manual-checklist.md); they run as simulated terminal scenes with `npm run media`.

## License

[MIT](LICENSE)
