# With other extensions and providers

The guard checks the account behind the model pi is about to use, so it works with anything that changes models through pi. How it treats the common cases:

## claude-bridge

A claude-bridge model takes its account from the environment key variable that Claude Code would use (`env:<VAR>`), else from the resolved `CLAUDE_CONFIG_DIR` (`~/.claude` by default), so a work and a personal config directory are different accounts. Cloud provider and `apiKeyHelper` setups share one `claude-code` account. The guard reads `settings.json` only to check that `apiKeyHelper` is set.

## pi-multi-pass

Rotation goes through `pi.setModel`, so the guard catches it as a model change. The guard does not depend on multi-pass's own allow list.

## pi-multiprovider pools

A provider id that pools several accounts gets a warning in the tag prompt: tag it only if all of them share one zone. A pool alone never blocks.

## Virtual routing models

such as `switchboard/auto` are tagged like any other account. Tag one only with zones in which every possible member is allowed. The member behind it is not checked.

![With pi-switchboard, switchboard/auto asks for its zones like any account; tagged personal, the turn runs and /guard shows switchboard (env:virtual) as one account with a Match](https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-account-guard/media/with-switchboard.gif)

An account is a provider id plus its auth source ([ADR 0002](adr/0002-account-is-provider-id-plus-auth-source.md)); a virtual model is its own account ([ADR 0004](adr/0004-virtual-model-is-its-own-account.md)).
