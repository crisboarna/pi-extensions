# Commands

![/guard in ~/work/acme-api: the place is work by rule 1, remote */acme-corp/*; the account acme is work, a Match; spare is untagged](https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-account-guard/media/guard-status.gif)

![In the client repository ~/projects/billing-portal the work account would be blocked; /guard place add path=here zone=work makes it work at once, and /guard place list marks the new rule as the one that decides this place](https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-account-guard/media/place-add.gif)

Every command takes full arguments, so it works without dialogs. Dialogs only fill in what is missing.

| Command | What it does |
|---|---|
| `/guard` | Prints a status block: the place and the rule that decides it, the current account and its Match, overrides, the config file and whether it is valid, zones, pooled provider ids and untagged accounts. |
| `/guard tag [provider [source] [zones]]` | Tags an account. With no arguments it tags the current account. A provider alone means its current source. Zones are comma-separated. Changing the zones of a tagged account shows old to new and asks to confirm. |
| `/guard untag [provider [source]]` | Removes a tag. No confirm: an untagged account fails closed. |
| `/guard place add [path=<path\|here>] [remote=<glob>] [zone=<zone>] [at=<n>]` | Adds a place rule, at the top unless `at` says otherwise. With no `path` or `remote` it shows which rule decides this place and offers this directory, one of its remotes or both, then a zone. |
| `/guard place list` | Numbers the rules and marks the one that decides this place. |
| `/guard place remove <n>` | Removes rule `n`. Confirms only when this place's zone changes. |
| `/guard place move <n> <to>` | Moves rule `n` to position `to`. Confirms only when this place's zone changes. |
| `/guard zone add <name>` | Declares a zone. |
| `/guard zone remove <zone>` | Removes a zone. Refused, with the list of references, while a tag, a rule or `defaultZone` uses it. |
| `/guard zone rename <old> <new>` | Renames a zone and rewrites every reference in one atomic write. |
| `/guard zone default <zone>` | Sets the default zone. Confirms when this place falls to the default and its zone would change. |

`/guard` prints the same text in the TUI and over RPC, and nothing in print and JSON mode. With no UI, a command with missing arguments fails with its usage on stderr and exit code 2, and a change to the zones of an already tagged account is refused because it cannot be confirmed (untag first).
