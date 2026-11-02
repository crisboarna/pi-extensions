---
"@crisboarna/pi-account-guard": minor
---

First release: the account guard, which blocks a turn when the model account does not belong to the zone of the session's directory.

- **Fails closed.** An untagged account, a broken config or a git failure blocks the turn and says why. In print and JSON mode a block exits with code 77 and the reason on stderr.
- **A fix in one keystroke.** The interactive block offers Switch to an account of this zone, Allow once, Allow for session or Cancel, which puts your prompt back.
- **Tags itself on first use.** Each new account asks once which zones it belongs to. The guard reads no secrets: an account is a provider id and its auth source, never the key.
- **Catches rotators and routers mid-turn.** A model change into the wrong zone during a turn aborts the turn and offers the previous account first.
- **`/guard` commands.** `/guard` shows the place rule that decides the directory and whether the account matches; `/guard place`, `zone` and `tag` edit the rules; `/guard check <path|here> [provider [source]]` says whether a turn would go, be blocked or ask first, and writes nothing; `/guard tour` walks through what the guard checks in four steps.
- **A footer** shows `guard personal ✓`, or `guard personal ✗ openai is work` before a turn would be blocked.
- **A `pi-account-guard` skill** that explains why a turn was blocked and proposes `/guard` commands for you to run. It never proposes a way around a block.
