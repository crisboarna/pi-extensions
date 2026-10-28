---
"@crisboarna/pi-switchboard": patch
---

`classifier setup llamacpp-chat` works on a first run. The one-time download command starts a single-model server on the router's port when it finishes; setup took it for the router, asked it to load the model, got a 404 and stopped. setup now waits for a llama.cpp router before loading the model, the download command loads the model with an 8,192-token context instead of the full 262,144, and `classifier detect` says that pi reads chat models from a router once they are loaded, and how to load one.
