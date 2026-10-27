---
"@crisboarna/pi-switchboard": minor
---

`pi-switchboard classifier setup <lmstudio|ollama|llamacpp|llamacpp-chat>` gets a classifier server ready with the product's own commands: it checks the product is installed (it never installs it), shows the commands and asks before running them, waits for the server, tests the model, chooses its threshold on the 24 labelled requests, and adds it to `pi-switchboard.json` after showing the change. `llamacpp-chat` sets up a chat model that pi reads as a classifier, the best-measured route.
