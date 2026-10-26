# Manual checklist

The checks in DESIGN.md section 17.2 need a real terminal UI, real accounts or other extensions, so no automated test covers them. Run each item once on a real pi install and fill in the Result column (pass or fail, the date, the pi version and a short note). The Result column is empty until someone has run the item.

**Status: not yet run.** No item below has been run.

## Setup

- Install the extension from this checkout: `pi install /path/to/pi-account-guard`.
- Use a throwaway agent directory so the real config is untouched: `export PI_CODING_AGENT_DIR=$(mktemp -d)`. Log in to at least two accounts under different provider ids, or use two stored keys, in that directory.
- Make two directories: `~/guard-check/work` and `~/guard-check/personal`.
- Write `$PI_CODING_AGENT_DIR/account-guard.json` with one place rule per directory (`work` and `personal`) and tag exactly one account `work` and one `personal`.

## Checks

| # | Item | Steps | Expected | Result |
|---|---|---|---|---|
| 1 | The dialogs look right in a real TUI: Block select | In `~/guard-check/personal`, start `pi` with the `work` account selected and send any prompt. | One select opens titled `BLOCKED <account> is zone work`, with the second line `Place <dir> -> zone personal`. Rows in order: a Switch row for each matching account, `Allow once: ...`, `Allow for session: ...`, `Cancel`. Text is not clipped or misaligned. Cancel returns the typed prompt to the editor. |  |
| 2 | The dialogs look right in a real TUI: Allow once and Allow for session | In the same Block, choose `Allow once`, confirm, then send a second prompt. Then choose `Allow for session` on the next Block. | Allow once shows a yes/no confirm naming the account and the place zone, sends one turn and blocks the next. Allow for session sends with no confirm and the footer shows `guard OVERRIDE <account> in personal`. |  |
| 3 | The dialogs look right in a real TUI: tag prompt | Log in to a third account with no tag, select it in `~/guard-check/personal` and send a prompt. | A checkbox list opens (nothing pre-checked, up/down to move, space to check, enter to confirm, esc to cancel). Tagging `personal` sends the turn at once. Esc falls through to the Block select. The config file now lists the account. |  |
| 4 | The dialogs look right in a real TUI: mid-turn change | Start a long prompt on a matching account, then switch to a non-matching account with `/model` while it runs. | The turn aborts with a notice that says a failover was blocked. After the turn stops, a select opens with the previous account first and no `Allow once` row. Cancel leaves the model as it is. |  |
| 5 | The footer item appears once placed in powerline `customItems` | With pi-powerline-footer installed and no `guard` key in `powerline.customItems`, start `pi` and look at the footer. Add `guard` to `powerline.customItems`, run `/reload`, look again. | The guard text is absent before the change and present after. It reads `guard personal ✓` on a Match. It changes to `✗ <account> is work` after switching to the `work` account and to `? untagged` on an untagged account. |  |
| 6 | Real pi-multi-pass rotation gives a Block plus a Switch | With pi-multi-pass installed, put a `personal` and a `work` account in one pool. In `~/guard-check/personal`, run a prompt on the `personal` account and make it hit a rate limit (or force a rotation with the multi-pass command). | Multi-pass rotates to the `work` account and the guard aborts the turn with the failover notice. Once idle, the select offers the `personal` account as the first Switch row. Choosing it restores the model. Multi-pass does not loop. |  |
| 7 | `switchboard/auto` tagged as an Account blocks and allows as tagged | With pi-switchboard installed, run `/guard tag switchboard auto personal` (use the provider id and source that `/guard` lists for it). In `~/guard-check/work`, select `switchboard/auto` and send a prompt. Then do the same in `~/guard-check/personal`. | In the `work` place the turn is blocked (the virtual model is tagged `personal`). In the `personal` place the turn is sent. `/guard` shows it as its own account. |  |
| 8 | The claude-bridge account resolves to its environment key or config directory | With pi-claude-bridge installed, run `/guard` with a claude-bridge model selected. Repeat with `ANTHROPIC_API_KEY` set, with `CLAUDE_CONFIG_DIR=~/.claude-work` set, and with both unset. | `/guard` and the tag prompt name the account by its source: `env:ANTHROPIC_API_KEY` when the key is set, `Claude Code login <CLAUDE_CONFIG_DIR>` (source `claude-config:<dir>`) when only the directory is set, and `Claude Code login ~/.claude` when neither is. Different directories give different accounts. No secret appears. |  |

## Record

| Field | Value |
|---|---|
| pi version |  |
| Terminal and OS |  |
| Run by and date |  |
| Extensions installed (name and version) |  |
