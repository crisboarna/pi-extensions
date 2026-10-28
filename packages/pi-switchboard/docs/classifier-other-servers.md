# Other servers

Any server that answers `POST <baseUrl>/systemone` in the System One format works as a classifier provider:

```json
"classifierProviders": [{ "name": "myserver", "baseUrl": "http://127.0.0.1:9000/v1/", "models": ["model-id"], "apiKey": "$MYSERVER_KEY" }],
"classifiers": [{ "model": "myserver/model-id", "timeoutMs": 2000, "threshold": 0.8 }]
```

`apiKey` is optional; `$NAME` reads it from the environment. Test any such server with `pi-switchboard classifier eval <baseUrl> <model>` before adding it. Of the servers on this page, only LiteLLM was run for this guide.

## Unsloth

[Unsloth Studio](https://unsloth.ai/docs/new/studio) runs models locally and serves them on OpenAI- and Anthropic-compatible chat endpoints (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`), with no decision endpoint, so it cannot be a classifier provider. Use Unsloth's GGUF builds with llama.cpp instead: the best-measured route is Unsloth's `Qwen3-4B-Instruct-2507-GGUF`, read by pi's `llama.cpp` provider. See [llama.cpp: a chat model](classifier-llama-cpp.md#a-chat-model-best-routing).

## vLLM

LiteLLM's docs list vLLM 0.32 and later as serving decision models. Whether vLLM itself answers on `/v1/systemone` was not checked here: if `curl -s <vllm>/v1/systemone -d '...'` answers with `answers`, add it like any server above; otherwise put LiteLLM in front of it with `model: hosted_vllm/<model>` and `api_base: <vllm>/v1`, as was run with LM Studio below.

## LiteLLM

The [LiteLLM proxy](https://docs.litellm.ai/docs/decisions) (v1.104.2 or later) serves every decision model in its `model_list` on `/v1/systemone`, translating to each provider: OpenAI's Luna, TypeSafe's Jev, vLLM (`hosted_vllm/...`), Nimble.

```yaml
# config.yaml
model_list:
  - model_name: jev
    litellm_params:
      model: typesafe/jev-latest
      api_key: os.environ/TYPESAFE_API_KEY
```

LiteLLM refuses to start without a master key, so set one, and give pi the same value:

```bash
export LITELLM_MASTER_KEY=sk-$(openssl rand -hex 16)
export LITELLM_API_KEY=$LITELLM_MASTER_KEY   # the key pi sends
litellm --config config.yaml          # listens on port 4000
```

```json
"classifierProviders": [{ "name": "litellm", "baseUrl": "http://127.0.0.1:4000/v1/", "models": ["jev"], "apiKey": "$LITELLM_API_KEY" }],
"classifiers": [{ "model": "litellm/jev", "timeoutMs": 3000, "threshold": 0.8 }]
```

Run on 2026-10-28 with LiteLLM 1.106.5 in Docker, in front of LM Studio instead of a cloud (`model: hosted_vllm/h2o-lightning-4b`, `api_base: http://host.docker.internal:1234/v1`): LiteLLM forwarded System One requests unchanged, `/tier doctor` said the classifier answered in 112 ms, and `/tier eval` routed 22 of 24, the same as LM Studio directly. Without `LITELLM_API_KEY` in pi's environment, doctor says the key could not be read.

**Privacy:** pi-switchboard decides whether a classifier is remote from its server's address. A LiteLLM proxy on this machine counts as local even when it forwards your request text to a cloud provider, so no `allowRemote` is asked for. Use a proxy only for classifiers you are content to send request text to.

## mlx-serve

[mlx-serve](https://github.com/ddalcu/mlx-serve) serves decision models on `/v1/decisions` (OpenAI's format), not `/v1/systemone`, so it cannot be a classifier provider. See [MLX](classifier-mlx.md).
