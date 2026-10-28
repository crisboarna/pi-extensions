# Classifier with Ollama

Ollama 0.35 and later serve decision models on `POST /v1/systemone`. Of the ones it offers, Tev1 (4.4 GB) routed 21 of the 24 labelled requests at threshold 0.7 and Nimble (9.3 GB) 17 ([measurements](classifier-models.md)). Checked on 2026-10-27 with Ollama 0.40.11 in Docker, CPU only; there Tev1 took about 3 s a request, too slow for pi-switchboard's 4 s decision budget, so on a machine without a GPU prefer a smaller model or another route. With a GPU it answers in a fraction of that.

## With setup

```bash
pi-switchboard classifier setup ollama
```

It finds `ollama`, waits for the server if it is not running (open the Ollama app, or run `ollama serve`), shows `ollama pull tev1` and asks, pulls it, tests the model, chooses its threshold and timeout with eval, and adds the classifier after showing the change.

## By hand

1. Install Ollama 0.35 or later from [ollama.com/download](https://ollama.com/download) and start it.
2. Pull the model and check it is a decision model:

   ```bash
   ollama pull tev1
   curl -s http://127.0.0.1:11434/api/show -d '{"model":"tev1"}' | grep -o '"capabilities":\[[^]]*\]'   # "decision"
   ```

3. Choose the threshold and timeout:

   ```bash
   pi-switchboard classifier eval http://127.0.0.1:11434/v1 tev1:latest
   # suggested "threshold": 0.7 (21/24, 0 too low)
   # suggested "timeoutMs": 6000 (twice the median, at least 2000), on CPU
   ```

4. Add to `~/.pi/agent/pi-switchboard.json`, then `/reload` in pi:

   ```json
   "classifierProviders": [{ "name": "ollama", "baseUrl": "http://127.0.0.1:11434/v1/", "models": ["tev1:latest"] }],
   "classifiers": [{ "model": "ollama/tev1:latest", "timeoutMs": 6000, "threshold": 0.7 }]
   ```

5. `/tier doctor` in pi says how fast it answers. On the CPU-only test machine it said:

   ```text
   ! classifier ollama/tev1:latest answered in 16067 ms, more slowly than the 4000 ms budget for one decision (classification.decisionBudgetMs) ...
   ```

   That first answer included loading the model; a warm model answered in about 3 s there, and much faster on a GPU.

## Notes

- Ollama names models with a tag; use the id it lists (`tev1:latest`).
- **Cloud models.** `clef:cloud` and other ids ending in `:cloud` run in Ollama's cloud, relayed by your local server; they need a paid plan or credits and Ollama 0.40.5 or later. pi-switchboard counts them as remote and skips them unless the entry sets `"allowRemote": true`, since your request text leaves the machine. See [cloud classifiers](classifier-cloud.md).
- Clef and Clef Flash also run locally (18 GB and 11 GB), but crashed Ollama's runner on CPU in the test (`GGML_ASSERT`); they were not measured.
- Ollama unloads an idle model after 5 minutes. Set `keepWarmMs` on the classifier entry (for example `240000`) to keep it loaded between requests.
