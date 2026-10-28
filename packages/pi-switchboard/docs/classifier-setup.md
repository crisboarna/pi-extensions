# Classifier setup

pi-switchboard asks a classifier three typed questions about each request: what kind of work it is (`work`), how much reasoning it needs (`depth`), and whether a mistake would be costly (`risky`). One call answers all three. The classifier must be a **classifier model**, one that answers with a probability for each option, because the confidence gate relies on those probabilities. Chat models such as Haiku that only write text are not supported; a local chat model can still serve, through llama.cpp, which reads its token probabilities.

No classifier yet? Everything still works: requests use the profile's fallback tier, and `/tier try work=plan depth=1.8 risky=no <request>` shows how a request would route with answers you type.

## Pick a route

| Route | What runs | Setup | Measured (of 24) | Page |
|---|---|---|---|---|
| LM Studio | H2O-Lightning-4B, a decision model | `pi-switchboard classifier setup lmstudio` | 22, 0.4 s on Metal | [LM Studio](classifier-lm-studio.md) |
| llama.cpp, chat model | Qwen3-4B-Instruct (Unsloth GGUF), read by pi's `llama.cpp` provider | `pi-switchboard classifier setup llamacpp-chat` | **23** | [llama.cpp](classifier-llama-cpp.md) |
| llama.cpp, decision model | H2O-Lightning-4B, or Kev, lev, Julia-1, Laya | `pi-switchboard classifier setup llamacpp` | 21 | [llama.cpp](classifier-llama-cpp.md) |
| Ollama | Tev1, a decision model | `pi-switchboard classifier setup ollama` | 21 | [Ollama](classifier-ollama.md) |
| MLX on Apple Silicon | OptiQ, mlx-serve | by hand | 9 (near chance) | [MLX](classifier-mlx.md) |
| Hosted | OpenAI's GPT-6 Luna, TypeSafe's Jev, Cloudflare's Clef | a config entry | not measured here | [Cloud classifiers](classifier-cloud.md) |
| Other servers | Unsloth Studio, vLLM, LiteLLM | a config entry | LiteLLM in front of LM Studio: 22 | [Other servers](classifier-other-servers.md) |

The measurements, how they were taken and every model tried are in [classifier models compared](classifier-models.md). A Mac with LM Studio already installed is the shortest path; the llama.cpp chat-model route routed best.

## Find, set up and test

Three commands do the work; each setup page shows the same steps by hand.

```bash
pi-switchboard classifier detect          # finds LM Studio, Ollama and llama.cpp on their usual ports, tests one, prints the config
pi-switchboard classifier setup ollama    # downloads a model with the product's own command, tests it, writes the config
pi-switchboard classifier eval http://127.0.0.1:11434/v1 tev1   # 24 labelled requests: correct, too low, latency, and the threshold and timeout to use
```

The command is installed with the package: `~/.pi/agent/npm/node_modules/@crisboarna/pi-switchboard/bin/pi-switchboard.mjs`, or run it with `npx @crisboarna/pi-switchboard`. `setup` never installs LM Studio, Ollama or llama.cpp itself; it shows each command and asks before running it, and shows the config change before writing it.

Inside pi:

```text
/tier doctor            each classifier answers? how fast? what to fix
/tier eval              the first classifier on the 24 labelled requests
/tier eval ollama/tev1:latest --threshold 0.7
```

`/tier eval` reaches any classifier pi knows, including llama.cpp chat models and hosted ones (which get only the sample texts, after a confirm). Then `/reload` after changing the config.

## Tuning

- **`threshold`, per classifier.** A rule fires only when the answers it uses are at least this confident; below it, the request goes to the fallback tier. Models differ in how confident they sound, so use the value `eval` suggests. See [rules and confidence](rules-and-confidence.md).
- **`timeoutMs`, per classifier,** and **`classification.decisionBudgetMs`** (4 s) for the whole decision. A classifier slower than the budget never decides; `/tier doctor` warns about it. `setup` sizes `timeoutMs` from the measured latency.
- **`classification.temperature`** softens a chat model's overconfident probabilities (2 is a good start); decision models ignore it.
- **Warm-up.** The first request may load the model (2 to 20 s). pi-switchboard sends a warm-up call at session start; a classifier entry's `keepWarmMs` repeats it while idle.

## Several classifiers

`classifiers` are tried in order within one decision, inside `classification.decisionBudgetMs`. Each entry may set its own `threshold` and `timeoutMs`.

## Remote classifiers

A classifier whose server is not on this machine receives your request text. pi-switchboard skips it, and the decision record says so, unless its entry sets `"allowRemote": true`. Whether a classifier is remote comes from its server's address, so pi's built-in hosted classifiers (Luna, Jev, Clef) count as remote. Ollama's cloud models (`clef:cloud` and other ids ending in `:cloud` or `-cloud`) count as remote too, although a local Ollama server relays them. A local proxy that forwards to a cloud, such as LiteLLM, counts as local by its address; see [other servers](classifier-other-servers.md).

## What the classifier sees

The request text, the plan phase from Plannotator, recent tool outcomes and short tool errors, bounded by `classification.evidence` and redacted once (home directory, tokens, keys, and your own `evidence.redact` patterns) before it reaches the classifier, the session file or any log.
