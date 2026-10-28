# Classifier with llama.cpp

llama.cpp's `llama-server` gives pi-switchboard two kinds of classifier:

- **A chat model, read through its token probabilities.** pi's built-in `llama.cpp` provider asks a small instruct model one prompt per question and reads the probability of each answer label. Qwen3-4B-Instruct (Unsloth's GGUF) routed **23 of 24** labelled requests, the best of every model measured ([measurements](classifier-models.md)).
- **A decision model on `/v1/systemone`.** H2O-Lightning-4B routed 21 of 24; Kev-4B, lev, Laya and Julia-1 are smaller or faster but routed fewer.

Both were run on 2026-10-27 with the llama.cpp server image (`ghcr.io/ggml-org/llama.cpp:server`) in Docker, CPU only, and checked in real pi with `/tier doctor` and `/tier eval`. On a GPU (Metal, CUDA) they answer many times faster.

Install llama.cpp with `brew install llama.cpp` (macOS, Linux), a [release](https://github.com/ggml-org/llama.cpp/releases), or the newer `llama` command from [llama.app](https://llama.app) (`llama serve` takes the same options as `llama-server`).

## A chat model (best routing)

With setup:

```bash
pi-switchboard classifier setup llamacpp-chat
```

It prints the two commands below for you to run in another terminal, waits for the server, loads the model, and writes the classifier with a softer temperature. pi's `llama.cpp` provider works with llama-server in **router mode** (started without a model) and lists a router's models once they are loaded. By hand:

1. Download the model once (2.5 GB), and stop the server with Ctrl+C when it says it is listening:

   ```bash
   llama-server -hf unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M
   ```

2. Start the router, which serves the models in llama.cpp's download cache, and load the model:

   ```bash
   llama-server --port 8080 -c 8192 --jinja
   curl -s http://127.0.0.1:8080/models/load -d '{"model":"unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M"}'   # or /llama inside pi
   ```

3. Tell pi where the server is, in the shell you start pi from, or with `/login llama.cpp` inside pi:

   ```bash
   export LLAMA_BASE_URL=http://127.0.0.1:8080
   ```

4. Add to `~/.pi/agent/pi-switchboard.json`, then `/reload` in pi:

   ```json
   "classifiers": [{ "model": "llama.cpp/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M", "timeoutMs": 3000, "threshold": 0.8 }],
   "classification": { "temperature": 2 }
   ```

   `temperature` softens the raw label probabilities, which are overconfident; decision models ignore it. No `classifierProviders` entry is needed: pi's own provider serves the model.

5. Check it in pi (the measurement used the same model, loaded from a folder, so its id was the file name):

   ```text
   /tier doctor
   ✓ classifier llama.cpp/Qwen3-4B-Instruct-2507-Q4_K_M answered in 371 ms
   /tier eval
   23/24 on the expected tier, 0 too low ... suggested "threshold": 0.8 (23/24, 0 too low)
   ```

A chat model answers one prompt per question, about three times a decision model's work per request, and needs room for the request twice in its context (`-c 8192` is plenty). Any small instruct model works the same way; compare with `/tier eval` before switching.

## A decision model

With setup:

```bash
pi-switchboard classifier setup llamacpp
```

By hand:

1. Start the server (the first start downloads 2.7 GB):

   ```bash
   llama-server -hf h2oai/h2o-lightning-4b-gguf:Q4_K_M --port 8080 -c 8192
   ```

   With one model loaded, the server ignores the request's `model` field; `/v1/models` lists the model as `h2oai/h2o-lightning-4b-gguf:Q4_K_M`, marked with `"output_modalities": ["decisions"]`. Other decision models: `ggml-org/Kev-4B-GGUF`, `ggml-org/lev-GGUF`, `ggml-org/Laya-GGUF`, `ggml-org/Julia-1-GGUF`.
2. Choose the threshold:

   ```bash
   pi-switchboard classifier eval http://127.0.0.1:8080/v1 h2oai/h2o-lightning-4b-gguf:Q4_K_M
   ```

3. Add to `~/.pi/agent/pi-switchboard.json`, then `/reload`:

   ```json
   "classifierProviders": [{ "name": "llamacpp", "baseUrl": "http://127.0.0.1:8080/v1/", "models": ["h2oai/h2o-lightning-4b-gguf:Q4_K_M"] }],
   "classifiers": [{ "model": "llamacpp/h2oai/h2o-lightning-4b-gguf:Q4_K_M", "timeoutMs": 2000, "threshold": 0.7 }]
   ```

   With `LLAMA_BASE_URL` set, pi's own provider lists decision models too, as `llama.cpp/<model>`, so the `classifierProviders` entry is optional.

## Several models on one server (router mode)

Start `llama-server` without a model to serve every GGUF in a folder, each loaded on demand:

```bash
llama-server --models-dir ~/models --port 8080 -c 8192 --jinja
```

Without `--models-dir` the router serves what `-hf` downloaded, under ids such as `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M`; with it, the ids are the file names without `.gguf`. It does not download a model it has not cached. pi lists a router model only once it is loaded (unless it comes from a preset): load it with `/llama` in pi, or `curl -s http://127.0.0.1:8080/models/load -d '{"model":"<id>"}'`.

## Notes

- `pi-switchboard classifier detect` lists the server's decision models and its chat models, and prints what to add for either.
- Keep `--host 127.0.0.1` (the default) so the server is not reachable from the network. If you start it with `--api-key`, give the same key to pi (`/login llama.cpp`, or `LLAMA_API_KEY`) and to a `classifierProviders` entry as `"apiKey"`.
- Hybrid models such as Qwen3.5 may reprocess the whole request for each question; start the router with `--ctx-checkpoints 32 --checkpoint-min-step 0` if a chat model is slow.
