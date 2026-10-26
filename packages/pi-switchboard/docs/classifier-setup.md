# Classifier setup

pi-switchboard asks a decision classifier three typed questions about each request: what kind of work it is (`work`), how much reasoning it needs (`depth`), and whether a mistake would be costly (`risky`). One call answers all three. Any local server that answers `POST <baseUrl>/systemone` works: LM Studio, `llama-server` (llama.cpp build 11773 or later), or a model's own System One shim.

No classifier yet? Everything still works: requests use the profile's fallback tier, and `/tier try work=plan depth=1.8 risky=no <request>` shows how a request would route with answers you type.

## LM Studio with H2O-Lightning-4B (recommended)

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

Config (in `~/.pi/agent/pi-switchboard.json`):

```json
"classifierProviders": [{ "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1/", "models": ["h2o-lightning-4b"] }],
"classifiers": [{ "model": "lmstudio/h2o-lightning-4b", "timeoutMs": 2000, "threshold": 0.8 }]
```

Then run `/tier doctor`: it sends the classifier a warm-up request and says whether it answered.

Measured on an M5 Max: about 9 s on the first call while LM Studio loads the model, then 0.2–0.7 s per decision. pi-switchboard sends a warm-up call at session start; `keepWarmMs` repeats it while idle.

**If LM Studio also serves your chat models**, turn off its just-in-time option that keeps only the last loaded model, or load models explicitly with `lms load`. Otherwise the classifier and the chat model evict each other mid-request ("Model is unloaded").

## Several classifiers

`classifiers` are tried in order within one decision, inside `classification.decisionBudgetMs` (4 s). Each entry may set its own `threshold` and `timeoutMs`.

## Remote classifiers

A classifier whose server is not on this machine receives your request text. pi-switchboard skips it, and the decision record says so, unless its entry sets `"allowRemote": true`. Whether a classifier is remote comes from its server's address, so pi's built-in hosted classifiers (Jev, Clef) count as remote.

## What the classifier sees

The request text, the plan phase from Plannotator, recent tool outcomes and short tool errors, bounded by `classification.evidence` and redacted once (home directory, tokens, keys, and your own `evidence.redact` patterns) before it reaches the classifier, the session file or any log.
