# Classifier with MLX on Apple Silicon

**On a Mac, use [LM Studio](classifier-lm-studio.md)** (or [llama.cpp](classifier-llama-cpp.md)). Both run decision models on the Mac's GPU through Metal, from GGUF files: H2O-Lightning-4B answers in 0.2 to 0.4 s in LM Studio. No MLX route worked as well on 2026-10-27:

| Server | What happened | Status |
|---|---|---|
| LM Studio with MLX builds (`h2o-lightning-4b-mlx`, `kev-4b-mlx`) | LM Studio loads MLX builds of decision models as chat models and rejects System One requests for them (400). Download the GGUF build instead. | Checked |
| [OptiQ](https://mlx-optiq.com/docs/decision-models) 0.7.7 (`pip install mlx-optiq`, Python 3.11 to 3.14) | Serves decision models on `/v1/systemone`, but its Qwen3.5-0.8B and gemma-4-e2b decision models answered near chance (about 0.2 for each of five choices, 9 of 24 at every threshold), also on OptiQ's own documented example. Run again from a fresh install on 2026-10-28: the same 9 of 24. | Checked, not recommended |
| [mlx-serve](https://github.com/ddalcu/mlx-serve) | Serves Laya, Kev and D1 on `/v1/decisions`, OpenAI's format, not `/v1/systemone`, so pi-switchboard cannot use it as a classifier provider. | Read from its docs, not run |

## If you try OptiQ anyway

Install it into a virtual environment of its own; it brings Flask, Jinja2 and more, which a system-wide Python should not get. OptiQ requires `sk-optiq-` keys by default and rejects the placeholder key pi-switchboard sends, so start it without auth (it listens on 127.0.0.1 only) on a port of its own:

```bash
python3.11 -m venv ~/.optiq && ~/.optiq/bin/pip install mlx-optiq
~/.optiq/bin/optiq serve --model mlx-community/Qwen3.5-0.8B-decision --port 8181 --no-auth
pi-switchboard classifier eval http://127.0.0.1:8181/v1 mlx-community/Qwen3.5-0.8B-decision
```

**Start it twice the first time.** OptiQ decides at start-up whether to serve `/v1/systemone`, from the model it finds on disk. On the first start it downloads the model after that, so it serves chat only and answers System One requests with 404 (eval then says `did not answer`). Stop it with Ctrl+C and start it again: its log then says `decision model: POST /v1/systemone enabled`.

If eval routes well, add it like any System One server:

```json
"classifierProviders": [{ "name": "optiq", "baseUrl": "http://127.0.0.1:8181/v1/", "models": ["mlx-community/Qwen3.5-0.8B-decision"] }],
"classifiers": [{ "model": "optiq/mlx-community/Qwen3.5-0.8B-decision", "timeoutMs": 2000, "threshold": 0.8 }]
```

To keep auth on, start it with `--api-key <key>` and give the provider entry `"apiKey": "$OPTIQ_KEY"` (pi reads `$NAME` from the environment). OptiQ's default port, 8080, is llama.cpp's too; `classifier detect` does not look for OptiQ.
