# Classifier models compared

Which classifier routes best depends on the model, not the server it runs on. The table below comes from `pi-switchboard classifier eval`, run on 2026-10-27. It asks each model about the same 24 requests that a reviewer labelled before any classifier ran (a rename belongs on the light tier, a migration plan on the deep tier, dropping a production table on at least the standard tier), routes the answers through the built-in rules on three tiers, and counts how many land where the reviewer put them. Run it on your own setup, inside pi for any classifier pi knows, or from a shell for a System One server:

```text
/tier eval lmstudio/h2o-lightning-4b
/tier eval llama.cpp/Qwen3-4B-Instruct-2507-Q4_K_M --temperature 2
```

```bash
pi-switchboard classifier eval http://127.0.0.1:1234/v1 h2o-lightning-4b   # LM Studio's System One endpoint
```

"Too low" counts requests routed below their label: a small model on hard work, the costly kind of mistake. The best threshold is the one with the most correct answers and the fewest too low; models differ in how confident they sound, so set `"threshold"` per classifier to the value eval suggests.

| Model | Size | Served by | Correct of 24 (threshold) | Too low | Median per request | Where measured |
|---|---|---|---|---|---|---|
| Qwen3-4B-Instruct-2507, Q4_K_M (Unsloth GGUF), a chat model | 2.5 GB | llama.cpp, read by pi's `llama.cpp` provider at temperature 2 | **23** (0.6–0.8) | 0 | 1.4 s | Docker, CPU only |
| H2O-Lightning-4B, Q8_0 | 4.5 GB | LM Studio | **22** (0.5–0.6); 21 at 0.8 | 0 | 0.37 s (0.19 s warm) | M5 Max, Metal |
| H2O-Lightning-4B, Q4_K_M | 2.7 GB | llama.cpp | 21 (0.5–0.7); 20 at 0.8 | 0 | 5.4 s | Docker, CPU only |
| Tev1 | 4.4 GB | Ollama | 21 (0.7); 17 at 0.8 | 0 | 2.8 s | Docker, CPU only |
| lev, Q4_K_M | 3.0 GB | llama.cpp | 19 (0.5–0.6) | 1 | 4.8 s | Docker, CPU only |
| Nimble 9B | 9.3 GB | Ollama | 17 (0.5) | 0 | 4.5 s | Docker, CPU only |
| Kev-4B, Q4_K_M | 3.0 GB | llama.cpp | 15 (0.6) | 2 | 1.8 s | Docker, CPU only |
| Laya, Q8_0 | 0.45 GB | llama.cpp | 12 (0.5–0.6) | 3 | 0.18 s | Docker, CPU only |
| Julia-1, Q8_0 | 0.17 GB | llama.cpp | 10 (0.6–0.7) | 0 | 0.06 s | Docker, CPU only |
| Clef, Clef Flash | 18 GB, 11 GB | Ollama | not measured: the model crashed Ollama's runner on CPU (`GGML_ASSERT`) | | | Docker, CPU only |
| Qwen3.5-0.8B-decision, gemma-4-e2b decision (MLX) | 1.9 GB, 5.4 GB | OptiQ 0.7.7 | 9 at every threshold: answers near chance (about 0.2 for each of five choices), also on OptiQ's own documented example | 6 | 0.09 s, 0.18 s | M5 Max, MLX |

How to read it:

- **Recommended:** H2O-Lightning-4B in LM Studio for the shortest setup, and a small instruct chat model on llama.cpp for the best routing. Tev1 is the pick on Ollama.
- **24 requests are few.** A difference of one or two is noise; the gap between the top rows and Kev, Laya or Julia-1 is not. The small encoder models (Julia-1, Laya) are fast but unsure about these questions, so most requests fall to the fallback tier.
- **Latency.** The Docker runs had no GPU (Docker on a Mac cannot use Metal), so their times are many times slower than the same model on a GPU. Compare models by the correct column; measure latency on your own machine with eval. pi-switchboard's default budget for one decision is 4 s (`classification.decisionBudgetMs`), and `timeoutMs` per classifier is 2 s.
- **Chat models** answer through next-token probabilities, one prompt per question, so they take about three times a decision model's work per request. Their raw probabilities are overconfident; pi-switchboard's `classification.temperature` (2 here) softens them.

OptiQ needs `--no-auth` (or a key set in the classifier provider's `apiKey`), because pi-switchboard sends a placeholder key that OptiQ rejects.

Versions: llama.cpp server image `ghcr.io/ggml-org/llama.cpp@sha256:8ee4ec7c…` (2026-10-27), Ollama 0.40.11, LM Studio with its llama.cpp engine; Docker Desktop with 18 CPUs and 35 GB of memory on an Apple M5 Max.
