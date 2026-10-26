# PROTOTYPE (throwaway): what a Block looks like

Question: what does a Block look like in TUI, print (`-p`), JSON and RPC modes, including the picker, both Overrides and the mid-turn abort? Text mockups only; not part of the spec until folded into DESIGN.md.

## TUI Block: one flat `ctx.ui.select`, awaited inside the `input` handler

```
BLOCKED  anthropic (oauth) is zone work
Place ~/Projects/pi/diary -> zone personal

 > Switch to openai-codex-2 (oauth) -> gpt-5.5   [personal]
   Switch to anthropic (env:ANTHROPIC_API_KEY) -> claude-sonnet-5-5   [personal, work]
   Allow once: this turn to anthropic (oauth)
   Allow for session: anthropic (oauth)
   Cancel
```

Undecidable cause: only the title changes, no Switch rows.

```
BLOCKED  cannot read account-guard.json
         $.accounts[2].zones: unknown zone "wrk"
 Place ~/Projects/pi/diary -> zone unknown

 > Allow once ...
   Allow for session ...
   Cancel
```

Unknown account: tag prompt first (ticket: config schema and tag prompt flow). Cancel, or a tag that still gives no Match, falls to the select above.

```
Tag openai-codex-3 (oauth)   Place zone: personal
 [ ] work
 [ ] personal
 [ ] Several zones...
```

## Typed prompt

- Switch or Override: the handler returns `continue` after setting the model (`pi.setModel`) and recording the Override; the same prompt is sent. Notice: `Switched to openai-codex-2 (oauth), sending.`
- Cancel: handler returns `handled` and refills the editor (`ctx.ui.setEditorText`).
- Switch target model: same model id if the target account offers it, else its first model; the notice says so (`model gpt-5.5 (claude-sonnet-5-5 not offered)`).

## Overrides

```
Allow once?
 Send ONE turn to anthropic (oauth),
 zone work, from a personal Place.
 > Yes   No
```

Allow for session has no second confirm. While active: footer `guard: OVERRIDE anthropic (oauth) in personal places`. No per-turn warning.

Session log entries: `guard.block`, `guard.allow_once`, `guard.allow_session` (account, Place, zone).

## Mid-turn abort (model changed during a turn)

```
! guard: model changed to anthropic (oauth) [work] during a turn
  in a personal place (~/Projects/pi/diary). Turn aborted.

BLOCKED  anthropic (oauth) is zone work
Place ~/Projects/pi/diary -> zone personal

 > Switch back to openai-codex-2 (oauth)  [personal]
   Switch to anthropic (env:ANTHROPIC_API_KEY)  [personal, work]
   Allow for session: anthropic (oauth)
   Cancel   (stay on anthropic; next user turn is blocked)
```

No Allow once (there is no prompt to resend). Headless: stderr message, exit 77.

## Headless (print, JSON): stderr, exit code 77

```
$ pi -p "summarise the diary"
BLOCKED anthropic (oauth) is zone work; this place
(~/Projects/pi/diary) is zone personal. No turn was sent.

Fix, any one of:
  pi --model <an account in zone personal>
  add a place rule if this directory belongs to zone work
    in ~/.pi/agent/account-guard.json
$ echo $?
77
```

```
BLOCKED openai-codex-3 (oauth) has no zone tag; place zone is personal.
Add to ~/.pi/agent/account-guard.json accounts:
  {"provider":"openai-codex-3","source":"oauth","zones":["personal"]}
or run pi, then: /guard tag openai-codex-3 oauth personal
or set PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 for this process.
```

RPC: same dialogs through `extension_ui_request`; no answer counts as Cancel.
