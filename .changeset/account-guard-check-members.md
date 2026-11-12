---
"@crisboarna/pi-account-guard": minor
---

`/guard check` describes the models behind a virtual model. When the current model is a virtual one whose router lists its members, such as pi-switchboard's `switchboard/auto`, it lists each member with its account and whether it matches, and its verdict comes from all of them, as a turn's does. It names the member that would block the turn, or says why the router could not list them. With an account named in the command, it checks that account alone, as before.
