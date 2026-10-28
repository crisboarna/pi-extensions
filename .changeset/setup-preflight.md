---
"@crisboarna/pi-switchboard": patch
---

`classifier setup ollama` waits for the Ollama server, with a hint to start it, before running `ollama pull`, which needs the server; it used to stop with Ollama's own "could not connect" error. setup now checks that pi-switchboard.json is valid JSON before running anything, and says that nothing changed when you decline a prompt.
