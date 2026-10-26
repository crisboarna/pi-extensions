# Configuration

The config lives in `~/.pi/agent/pi-switchboard.json` (or the path in `PI_SWITCHBOARD_CONFIG`). The schema is [`schema/pi-switchboard.schema.json`](../schema/pi-switchboard.schema.json); add `"$schema"` to get completion in your editor. `/tier init` writes a first version from your signed-in models, and `/tier models` edits profiles, tiers and members through dialogs. Run `/reload` after editing by hand.

## The shape

```jsonc
{
  "classifierProviders": [{ "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1/", "models": ["h2o-lightning-4b"] }],
  "classifiers": [{ "model": "lmstudio/h2o-lightning-4b", "timeoutMs": 2000, "threshold": 0.8 }],
  "profiles": {
    "work": {
      "tiers": {
        "light":    { "rank": 1, "members": ["provider-a/small-model:low"] },
        "standard": { "rank": 2, "members": ["provider-a/mid-model", "provider-b/mid-model"], "strategy": "ordered" },
        "deep":     { "rank": 3, "members": ["provider-a/big-model:high"] }
      },
      "fallbackTier": "standard"
    }
  },
  "profileSelection": { "default": "work" }
}
```

- A **profile** maps tier names to members. Ranks order the tiers, so names are yours to choose.
- A **member** is `provider/model`, optionally with `:thinking`, or an object with `model`, `thinking`, `weight`, `enabled`, `maxConcurrency`, `schedule`, `budget` and `tags`.
- `fallbackTier` is used when the classifier is unsure or unreachable; `baselineTier` (default: the fallback tier) runs in dry-run; `directTier` (default: the lowest rank) serves pi's direct requests, which carry no routing state; it moves up a rank when the conversation does not fit the context window.

## The settings most people change

| Setting | Effect | Default |
|---|---|---|
| `profiles.<name>.tiers.<tier>.members` | which models a tier may use | none |
| `profiles.<name>.tiers.<tier>.strategy` | how a tier picks a member ([strategies](strategies-and-failover.md)) | `sticky` |
| `classifiers[].threshold` | how sure the classifier must be before a rule fires ([rules](rules-and-confidence.md)) | `classification.threshold`, 0.85 |
| `profiles.<name>.ruleset` | which answers map to which tier | the built-in ruleset |
| `subagents.agents.<agent>` | `minTier`, `maxTier` or `fixedTier` for a subagent | none |
| `budgets` | soft token and cost budgets per task and session | none |

## Choosing the profile

The first of these that names a valid profile wins, and the decision records which:

1. `/tier profile <name>` for this session (or selecting `switchboard/<name>` in `/model`).
2. `/tier profile <name> --global`, remembered in `state.json`.
3. `profile` in the project's `.pi/pi-switchboard.json`.
4. The first `profileSelection.rules` entry whose `matchProvider` or `matchModel` glob matches the model you had selected before `switchboard/auto` (accounts such as `provider-2` match `provider*`).
5. `profileSelection.default`.

A profile with `projects` (`["~/work/**"]`) is used only under those paths.

## Virtual models

| Model | Routes with |
|---|---|
| `switchboard/auto` | the profile chosen as above |
| `switchboard/<profile>` | that profile |
| `switchboard/<profile>.<tier>` | that profile, pinned to that tier (subagent launches use these) |

## Project files

A trusted project may add `.pi/pi-switchboard.json`: it can add or adjust profiles (tiers replace per tier), add rulesets, prepend selection rules, choose its `profile`, and set `subagents.agents`. It can never change classifiers or other settings; those keys are ignored with a warning.

## Examples

- [`two-subscriptions.json`](../examples/two-subscriptions.json): one profile per subscription, three tiers each.
- [`mixed-providers.json`](../examples/mixed-providers.json): five custom tiers across three providers, a shared round-robin tier, agent limits.
- [`local-only.json`](../examples/local-only.json): every tier on local models.
- [`single-tier.json`](../examples/single-tier.json): one tier, two subscriptions, least-recently-used.

Try one without touching your config: `PI_SWITCHBOARD_CONFIG=/path/to/example.json pi`.

## Checks

`/tier validate` and session start report: unknown tiers in rules, a missing or misplaced default rule, duplicate ranks, members that are not in pi's catalog or have no credentials (disabled with a warning), very different context windows in one tier, classifiers that are not registered or are remote without `allowRemote`, Plannotator setting a model for a phase, and a project's `.pi/multi-pass.json` restricting providers without `switchboard`. Errors disable only the broken profile. `/tier doctor` adds the live checks.
