---
name: pi-switchboard
description: Explain and tune pi-switchboard model routing. Use when the user asks why a model, tier or account was used, wants routing cheaper, stronger or different, or asks to edit pi-switchboard.json.
---

# pi-switchboard

pi-switchboard picks a model for every request: a local classifier answers typed questions (`work`, `depth`, `risky` by default), the profile's rules turn the answers into a tier, and the tier's strategy picks a member. Every choice is a decision record in the session file, outside your context. Slash commands are the user's; you work through the files and the `pi-switchboard` CLI.

## Find the records

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SB="node $AGENT_DIR/npm/node_modules/@crisboarna/pi-switchboard/bin/pi-switchboard.mjs"
SESSION=$(ls -t "$AGENT_DIR/sessions/--$(pwd | sed 's#^/##; s#/#-#g')--"/*.jsonl | head -1)
$SB replay "$SESSION" --json      # tasks, decisions, models, tool calls
```

The config is `$AGENT_DIR/pi-switchboard.json` (or `$PI_SWITCHBOARD_CONFIG`); a trusted project may add `.pi/pi-switchboard.json`. Its schema is `schema/pi-switchboard.schema.json` in the package.

## Explain a choice

1. Take the decision the user means from `tasks[].decisions` in the replay (default: the latest one with `reason: "user"`; subagent launches are under `tasks[].children`).
2. Explain it in this order, quoting the fields: the answers and their confidence, the rule that matched and whether its gate passed (`rules.gate`), the tier (`tier.why`, `borrowedFrom`), and the member (`selection.strategy`, `selection.why`, the excluded candidates and why).
3. Done when every hop from request to model is accounted for, including any fallback (`kind: "fallback"`: low confidence or no classifier) or failover (`error`).

## Tune routing

1. Find the cause in the records before changing anything: a wrong answer (classifier), a rule that matched too broadly, a threshold too high (frequent fallbacks), or a tier whose members are wrong.
2. Change the smallest thing that fixes it: a member list, a rule, `threshold`, or a tier's `strategy`. Show the user the diff and say which decisions it would have changed.
3. Leave `classifiers` and `classifierProviders` to the user: they decide which servers receive request text. A project file can never change them.
4. Tell the user to run `/tier validate`, then `/tier try <request>` to preview a request without running it, and `/reload` after saving.
