# pi-switchboard

A [pi](https://pi.dev) package that picks a model for every piece of work. A local decision classifier answers three typed questions about each request (what kind of work, how deep, how risky). Rules turn the answers into a tier, your profile maps the tier to one or more models, and a strategy picks one. It routes the main session and pi-subagents children, and it records every decision so you can see why each model ran and what it cost.

The source names no provider or model. Everything comes from your config.

## Install

```bash
pi install /path/to/pi-switchboard        # or: pi install npm:pi-switchboard
```

Restart pi, then:

```text
/tier init          # proposes profiles from your signed-in models, shows a diff, writes ~/.pi/agent/pi-switchboard.json
/model              # pick switchboard/auto (or switchboard/<profile>)
```

Requires Node 22.19 or later and pi 1.4 or later.

## How it works

```
user turn ─▶ evidence (request, plan phase, tool outcomes; redacted)
          ─▶ classifier (one call: work, depth, risky)
          ─▶ ruleset (first matching tier rule, then floor rules)
          ─▶ confidence gate (below the threshold: the fallback tier)
          ─▶ hysteresis, pin, escalation
          ─▶ strategy picks a member of the tier (health, cooldowns, affinity)
          ─▶ the request runs on that model; the decision is recorded
```

- **Main session**: select `switchboard/auto` (profile chosen by your rules), `switchboard/<profile>`, or `switchboard/<profile>.<tier>` (pinned tier).
- **Subagents**: when pi-subagents is installed, the parent classifies each task at launch and writes a tier-pinned model (`switchboard/<profile>.<tier>`) into the call. pi-switchboard is loaded into every native child, so failover and escalation also work inside children. Explicit models, agent frontmatter and `agentOverrides` are never overridden.
- **Failover**: usage limits bench the whole provider account, rate limits bench the model, overloads retry before switching. When every model of a tier is cooling down, the router borrows from the next tier up, then down.

Full design: [DESIGN.md](DESIGN.md). Terms: [GLOSSARY.md](GLOSSARY.md). Decisions: [docs/adr/](docs/adr/).

## Configuration

`~/.pi/agent/pi-switchboard.json` (schema: [`schema/pi-switchboard.schema.json`](schema/pi-switchboard.schema.json)). A project may add or adjust profiles in `.pi/pi-switchboard.json` once you trust it; it can never change classifiers.

Examples:

- [`examples/two-subscriptions.json`](examples/two-subscriptions.json): one profile per subscription, three tiers each.
- [`examples/mixed-providers.json`](examples/mixed-providers.json): five custom tiers across three providers, a shared round-robin tier, agent limits.
- [`examples/local-only.json`](examples/local-only.json): every tier on local models.
- [`examples/single-tier.json`](examples/single-tier.json): one tier, two subscriptions, least-recently-used.

To try an example without touching your config: `PI_SWITCHBOARD_CONFIG=/path/to/example.json pi`.

Profiles with no `ruleset` use the built-in one, which targets rank keywords so it works with any tier names:

| Answers | Tier |
|---|---|
| Plannotator in planning mode, `work` is plan or review, or `depth ≥ 1.5` | `@top` |
| `work` is mechanical or research and `depth < 1.0` | `@bottom` |
| anything else | `@middle` |
| `risky` (confident) | at least `@middle` |

### Confidence and thresholds

Choice and yes/no answers gate a rule; their confidence is on one scale (0 = even split, 1 = certain). A rule fires only when every gated answer it uses reaches the threshold. Depth is judged by its value, never by its confidence. Thresholds are per classifier (`classifiers[].threshold`), with `classification.threshold` (0.85) as the default and `profiles.<name>.threshold` as an override.

| Threshold | 5-option choice needs top probability | Yes/no needs |
|---|---|---|
| 0.70 | 0.76 | ≥ 0.85 or ≤ 0.15 |
| 0.80 | 0.84 | ≥ 0.90 or ≤ 0.10 |
| 0.85 | 0.88 | ≥ 0.925 or ≤ 0.075 |

`/tier report` shows the fallback rate and a confidence histogram, so you can tune it.

## Classifier setup

Any local server that answers `POST <baseUrl>/systemone` works: LM Studio, `llama-server` (llama.cpp build 11773 or later), or a model's own System One shim.

### LM Studio with H2O-Lightning-4B (recommended)

LM Studio treats a GGUF as a decision model only when its metadata declares a decision type. MLX builds load as chat models and are rejected.

```bash
mkdir -p ~/.lmstudio/models/h2oai/h2o-lightning-4b-gguf
curl -L -o ~/.lmstudio/models/h2oai/h2o-lightning-4b-gguf/h2o-lightning-4b-Q8_0.gguf \
  https://huggingface.co/h2oai/h2o-lightning-4b-gguf/resolve/main/h2o-lightning-4b-Q8_0.gguf
~/.lmstudio/bin/lms ls | grep h2o        # must show type "decision"
```

Smoke test (the API names the yes/no type `noul`):

```bash
curl -s http://127.0.0.1:1234/v1/systemone -H 'content-type: application/json' -d '{
  "model": "h2o-lightning-4b",
  "state": { "request": "rename the variable foo to bar" },
  "questions": { "work": { "type": "choice", "instructions": "What kind of work?",
    "criteria": { "plan": "Designing", "implement": "Writing code", "mechanical": "A small fully specified step" } } }
}'
```

Config:

```json
"classifierProviders": [{ "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1/", "models": ["h2o-lightning-4b"] }],
"classifiers": [{ "model": "lmstudio/h2o-lightning-4b", "timeoutMs": 2000, "threshold": 0.8 }]
```

Measured on an M5 Max: about 9 s on the first call while LM Studio loads the model, then 0.2–0.7 s per decision. pi-switchboard sends a warm-up call at session start; `keepWarmMs` repeats it while idle.

**If LM Studio also serves your chat models**, turn off its just-in-time option that keeps only the last loaded model, or load models explicitly with `lms load`. Otherwise the classifier and the chat model evict each other mid-request ("Model is unloaded").

Remote classifiers (Jev, Clef) need `"allowRemote": true` on the classifier entry, because they receive your request text.

## Footer

Add to `powerline.customItems` in `~/.pi/agent/settings.json`:

```json
{ "id": "tier", "statusKey": "tier", "position": "right", "prefix": "⇄", "hideWhenMissing": true },
{ "id": "tier-sub", "statusKey": "tier-sub", "position": "right", "hideWhenMissing": true }
```

Shows, for example, `copilot · deep · claude-opus-5.5 · 0.92`. Change it with `ui.status` (placeholders: `{profile} {tier} {rank} {member} {model} {provider} {account} {thinking} {strategy} {confidence} {reason} {kind} {switches}`).

## Commands

| Command | Does |
|---|---|
| `/tier` | Status, active profile and why, last decisions |
| `/tier init` | Propose a config from signed-in models (diff, then write) |
| `/tier models` | Edit profiles, tiers and members (diff and `.bak` before saving) |
| `/tier watch` or `Ctrl+Alt+W` | Live navigator: running tasks and subagents, decisions, transcripts |
| `/tier profile <name\|auto> [--global]` | Choose the profile |
| `/tier pin <tier\|@top\|@middle\|@bottom\|auto> [--subagents]` | Pin a tier |
| `/tier dry-run on\|off` | Classify and record, but run the baseline tier |
| `/tier log [n]`, `/tier explain [id]` | Decisions and their full reasoning |
| `/tier health` | Cooldowns, in-flight requests, latency |
| `/tier report`, `/tier budget` | Cost by tier, model and task; spend against budgets |
| `/tier validate` | Check the config |
| `/tier resume cancel` | Cancel a pending auto-continue |

`Ctrl+Alt` shortcuts need Ghostty's `macos-option-as-alt`; change the key with `ui.navigator.shortcut`.

## Inspector, replay and report

```bash
pi-switchboard inspect ~/.pi/agent/sessions/.../session.jsonl -o inspect.html   # offline HTML: tasks, decisions, costs, counterfactuals
pi-switchboard replay  session.jsonl [--json] [--reclassify]                    # text timeline; --reclassify re-runs local classifiers on the recorded evidence
pi-switchboard report  [--since 7d]                                             # cost by tier, model and provider across sessions
```

Decisions are custom session entries: they never enter the model's context. pi's `/export` HTML does not show them; use the inspector.

## Data and privacy

- Network calls go only to configured classifiers.
- pi-switchboard never reads `auth.json` or other credential files. It reads `multi-pass.json` for account names only.
- Evidence (request text, short tool errors) is redacted once (home directory, tokens, keys) before it reaches the classifier, the session entry or any log.
- Files under `~/.pi/agent/pi-switchboard/`: `health.json` (shared cooldowns and pointers), `usage.jsonl` (usage ledger), `state.json` (global profile), `live/` (subagent status and transcript mirrors, deleted 24 hours after a child ends), `decisions.jsonl` (only with `debug.log`).

## Uninstall

```bash
pi remove /path/to/pi-switchboard     # or: pi remove npm:pi-switchboard
rm -rf ~/.pi/agent/pi-switchboard ~/.pi/agent/pi-switchboard.json
```

Remove the two `powerline.customItems` entries if you added them.

## Known limitations

- **Workflow-script children** (`workflow: true`, `runs.run`, `runs.all`) are not routed: their script text is read from the reply, so no hook can change it.
- **Foreground children and `extensionBindings`**: pi-subagents does not pass bindings to foreground children; pi-switchboard does not need them (it uses tier-pinned models). Upstream fix: [pi-subagents#3049](https://github.com/nicobailon/pi-subagents/pull/3049).
- **`/model` size**: every tier of every profile appears as `switchboard/<profile>.<tier>`.
- **Usage-limit failover rewrites the error text** of the failed message so pi retries it; the original error stays in the decision record.
- **`--reclassify` outside pi** only reaches local System One classifiers; remote ones need pi's credentials.
- **`/tier` commands print through pi's notifications**, which print mode (`pi -p`) does not show.
- **Not yet verified end to end**: a real pi-subagents child launched by a model on a tier-pinned model. The parts are unit-tested and the main session is verified live; see DESIGN.md section 19.

## Development

```bash
npm run link:pi      # links the installed pi release into node_modules for types and tests
npm test             # unit tests (node --test, no dependencies)
npm run typecheck
```

`test/support/lmstudio-chat.ts` registers LM Studio's chat models as a pi provider for free local end-to-end runs:

```bash
PI_SWITCHBOARD_CONFIG=/path/to/local.json pi -ne -e ./src/index.ts -e ./test/support/lmstudio-chat.ts \
  --model switchboard/auto -p "rename foo to bar"
```

## License

MIT
