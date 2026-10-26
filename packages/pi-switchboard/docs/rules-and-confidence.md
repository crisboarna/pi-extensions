# Rules and confidence

The classifier's answers become a tier through the profile's **ruleset**: tier rules are checked in order and the first match wins, then every matching floor rule can raise the tier. A rule fires only when the answers it uses are confident enough.

## The built-in ruleset

Profiles with no `ruleset` use the built-in one. It targets rank keywords (`@top`, `@middle`, `@bottom`), so it works with any tier names:

| Answers | Tier |
|---|---|
| Plannotator in planning mode, `work` is plan or review, or `depth ≥ 1.5` | `@top` |
| `work` is mechanical or research and `depth < 1.0` | `@bottom` |
| anything else | `@middle` |
| `risky` (confident) | at least `@middle` |

`@middle` is the upper median by rank, so with an even number of tiers it rounds toward the stronger one.

## Writing rules

```json
"rulesets": {
  "quality-first": {
    "tierRules": [
      { "when": { "$planMode": "planning" }, "tier": "@top" },
      { "when": { "work": ["plan", "review"] }, "tier": "@top" },
      { "when": { "work": "mechanical", "depth": "<0.5" }, "tier": "@bottom" },
      { "tier": "@middle" }
    ],
    "floorRules": [{ "when": { "risky": true }, "atLeast": "@middle" }]
  }
}
```

A profile uses it with `"ruleset": "quality-first"`, or inlines `{ "tierRules": [...] }`. A ruleset ends with exactly one default rule (no `when`). `when` is an object (every key must match) or a list of objects (any one must match).

| Question type | Forms | Meaning |
|---|---|---|
| choice | `"plan"`, `["plan", "review"]`, `{ "not": "plan" }` | the chosen label |
| score | `"deep"`, `2` | the nearest level, by label or index |
| score | `"<1"`, `">=1.5"` | the level index, `0` to `n-1` |
| bool | `true`, `false` | probability of true at least 0.5 |
| bool | `">0.7"` | the probability of true |
| signal | `"$planMode": "planning"`, `"$scope": "subagent"`, `"$agent": "scout"` | exact or list match |

## Confidence and thresholds

Choice and yes/no answers gate a rule; their confidence is on one scale (0 = even split, 1 = certain). A rule fires only when every gated answer it uses reaches the threshold; otherwise the request goes to the profile's `fallbackTier`. Depth is judged by its value, never by its confidence.

Thresholds are per classifier (`classifiers[].threshold`), with `classification.threshold` (0.85) as the default and `profiles.<name>.threshold` as an override.

| Threshold | 5-option choice needs top probability | Yes/no needs |
|---|---|---|
| 0.70 | 0.76 | ≥ 0.85 or ≤ 0.15 |
| 0.80 | 0.84 | ≥ 0.90 or ≤ 0.10 |
| 0.85 | 0.88 | ≥ 0.925 or ≤ 0.075 |

## Tuning

- `/tier report` shows the fallback rate and a histogram of gate confidence. Many fallbacks mean the threshold is too high for your classifier.
- `/tier try <request>` shows the answers, the rule, the gate and the model for one request without running it. `/tier try work=review depth=2 risky=yes <request>` does the same with answers you type.
- `pi-switchboard replay <session.jsonl> --reclassify` re-runs local classifiers on recorded evidence, to compare a changed ruleset or classifier against real past requests.

## After the tier is chosen

- **Hysteresis**: moving down a tier waits `hysteresis.downTurns` (2) consecutive turns, so one small follow-up does not drop a hard task to the small model.
- **Escalation**: within a task, the same tool failing `escalation.sameToolErrors` (2) times, or `totalToolErrors` (3) failures, raises the tier one rank, at most `maxPerTask` (1) times.
- **Pins**: `/tier pin <tier>` skips classification; `/tier dry-run on` classifies and records but runs the `baselineTier`.
