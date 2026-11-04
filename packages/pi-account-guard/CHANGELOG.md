# @crisboarna/pi-account-guard

## 0.1.0

### Minor Changes

- [#218](https://github.com/crisboarna/pi-extensions/pull/218) [`cc9db0c`](https://github.com/crisboarna/pi-extensions/commit/cc9db0c75524d31bc98bf0a0c38459e7e42b1864) Thanks [@crisboarna](https://github.com/crisboarna)! - First release: the account guard, which blocks a turn when the model account does not belong to the zone of the session's directory.
  
  - **Fails closed.** An untagged account, a broken config or a git failure blocks the turn and says why. In print and JSON mode a block exits with code 77 and the reason on stderr.
  - **A fix in one keystroke.** The interactive block offers Switch to an account of this zone, Allow once, Allow for session or Cancel, which puts your prompt back.
  - **Tags itself on first use.** Each new account asks once which zones it belongs to. The guard reads no secrets: an account is a provider id and its auth source, never the key.
  - **Catches rotators and routers mid-turn.** A model change into the wrong zone during a turn aborts the turn and offers the previous account first.
  - **`/guard` commands.** `/guard` shows the place rule that decides the directory and whether the account matches; `/guard place`, `zone` and `tag` edit the rules; `/guard check <path|here> [provider [source]]` says whether a turn would go, be blocked or ask first, and writes nothing; `/guard tour` walks through what the guard checks in four steps.
  - **A footer** shows `guard personal ✓`, or `guard personal ✗ openai is work` before a turn would be blocked.
  - **A `pi-account-guard` skill** that explains why a turn was blocked and proposes `/guard` commands for you to run. It never proposes a way around a block.
  - **Tested against a stated range of pi.** It declares pi `>=1.4.0 <2`, the range CI runs the suites against, instead of promising every version.
  - **An editor checks the config as you type.** The example config starts with a `$schema` line, and the guard accepts it and keeps it when it writes the file.
