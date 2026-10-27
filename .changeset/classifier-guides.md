---
"@crisboarna/pi-switchboard": patch
---

Classifier setup guides for LM Studio, llama.cpp (decision models and chat models), Ollama, MLX, hosted classifiers (GPT-6 Luna, Jev, Clef) and other servers (Unsloth, vLLM, LiteLLM), each with commands, a smoke test, the config and measured results. A classifier provider's `apiKey` written as `$NAME` is now read from the environment by the `pi-switchboard` command as well, and `classifier setup llamacpp-chat` starts llama-server in router mode and loads the model, which pi's `llama.cpp` provider needs.
