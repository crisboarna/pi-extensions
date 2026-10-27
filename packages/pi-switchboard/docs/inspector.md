# Inspector, replay and report

Every decision is a custom entry in the pi session file. Decisions never enter the model's context, and pi's `/export` HTML does not show them; these tools do.

## In pi

- `/tier explain [id]`: the reasoning of one decision.
- `/tier watch`: the live navigator.
- `/tier inspect --open`: writes and opens the offline HTML inspector for the current session.

## On the command line

```bash
pi-switchboard inspect ~/.pi/agent/sessions/.../session.jsonl -o inspect.html   # offline HTML
pi-switchboard replay  session.jsonl [--json] [--reclassify]                    # text or JSON timeline
pi-switchboard report  [--since 7d] [--sessions <dir>]                          # cost across sessions
pi-switchboard classifier eval <baseUrl> <model> [--json]                       # a classifier on 24 labelled requests
```

The command is installed with the package (`~/.pi/agent/npm/node_modules/@crisboarna/pi-switchboard/bin/pi-switchboard.mjs`).

- **inspect** shows each task with its decisions, every model request (tokens, cost, duration, switches), tool calls and the subagents it launched, nested with their own decisions. With the profile snapshot recorded in the session, it also estimates what the task would have cost on the top tier and on the baseline tier.
- **replay** prints the same timeline as text, or JSON with `--json`. `--reclassify` re-runs local classifiers on the recorded evidence, to compare a changed classifier or ruleset against real past requests.
- **report** sums cost by tier, model and provider across sessions.
