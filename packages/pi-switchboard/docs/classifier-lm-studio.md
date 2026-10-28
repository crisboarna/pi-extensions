# Classifier with LM Studio

LM Studio serves decision models on `POST /v1/systemone` from its local server. On a Mac it runs them on the GPU (Metal): H2O-Lightning-4B answers pi-switchboard's three questions in 0.2 to 0.4 s and routes 22 of the 24 labelled requests as a reviewer would ([measurements](classifier-models.md)). Checked on 2026-10-27 on an M5 Max, and on 2026-10-28 with `classifier setup lmstudio` from a fresh install: 22 of 24 at 0.6, 0.2 s a request.

## With setup

```bash
pi-switchboard classifier setup lmstudio
```

It finds `lms` (on the PATH, or `~/.lmstudio/bin/lms`), shows the three commands below and asks, runs them, tests the model, chooses its threshold and timeout with eval, and adds the classifier to `~/.pi/agent/pi-switchboard.json` after showing the change. Run again while the model is loaded, it skips the commands.

## By hand

1. Install LM Studio from [lmstudio.ai](https://lmstudio.ai) and open it once; it installs the `lms` command.
2. Download the decision model, start the server and load the model:

   ```bash
   lms get https://huggingface.co/h2oai/h2o-lightning-4b-gguf/blob/main/h2o-lightning-4b-Q8_0.gguf --gguf -y   # Q8_0, the file measured here
   lms server start
   lms load h2o-lightning-4b@q8_0 -y -c 8192 --identifier h2o-lightning-4b   # a classifier needs a few thousand tokens of context
   lms ls | grep -A3 DECISION                                            # lists it under DECISION
   ```

   Without a file named, `lms get -y` takes the variant LM Studio prefers for the memory free at that moment, which can differ from run to run. On a machine with little memory, choose a smaller file by hand with `lms get https://huggingface.co/h2oai/h2o-lightning-4b-gguf --select` (not one marked Stock: those are for the model's Python shim), load it by the name `lms get` prints, and keep `--identifier h2o-lightning-4b`; the [model card](https://huggingface.co/h2oai/h2o-lightning-4b-gguf) lists what each file changes. Without `-c`, LM Studio loads the model with its full 262,144-token context: 12.6 GB of memory instead of 4.8 GB, and no better routing. Download the GGUF build. MLX builds of decision models (`h2o-lightning-4b-mlx`, `kev-4b-mlx`) load as chat models, and LM Studio rejects System One requests for them with a 400.
3. Smoke test (the API names the yes/no type `noul`):

   ```bash
   curl -s http://127.0.0.1:1234/v1/systemone -H 'content-type: application/json' -d '{
     "model": "h2o-lightning-4b",
     "state": { "request": "rename the variable foo to bar" },
     "questions": { "work": { "type": "choice", "instructions": "What kind of work?",
       "criteria": { "plan": "Designing", "implement": "Writing code", "mechanical": "A small fully specified step" } } }
   }'
   ```

4. Choose the threshold and timeout:

   ```bash
   pi-switchboard classifier eval http://127.0.0.1:1234/v1 h2o-lightning-4b
   # 21/24 on the expected tier, 0 too low ... suggested "threshold": 0.6 (22/24, 0 too low)
   # suggested "timeoutMs": 2000 (twice the median, at least 2000)
   ```

5. Add to `~/.pi/agent/pi-switchboard.json`, then `/reload` in pi:

   ```json
   "classifierProviders": [{ "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1/", "models": ["h2o-lightning-4b"] }],
   "classifiers": [{ "model": "lmstudio/h2o-lightning-4b", "timeoutMs": 2000, "threshold": 0.6 }]
   ```

6. `/tier doctor` in pi should say:

   ```text
   ✓ classifier lmstudio/h2o-lightning-4b answered in 444 ms
   ```

## Notes

- The first request after loading takes a few seconds; pi-switchboard's warm-up at session start covers it.
- `lms load` on a model that is already loaded loads a second copy (`h2o-lightning-4b:2`), with the memory that takes; `lms ps` lists what is loaded, and `lms unload h2o-lightning-4b:2` removes a copy.
- **If LM Studio also serves your chat models**, turn off its just-in-time option that keeps only the last loaded model, or load models explicitly with `lms load`. Otherwise the classifier and the chat model evict each other mid-request ("Model is unloaded").
- Other decision models work the same way: `lms get https://huggingface.co/ggml-org/Julia-1-GGUF --gguf -y`, then `lms load julia-1 -y -c 8192`. Compare them with `classifier eval` before switching.
