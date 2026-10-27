---
"@crisboarna/pi-switchboard": patch
---

Ollama's cloud models (ids ending in `:cloud` or `-cloud`) now count as remote classifiers, so request text no longer reaches Ollama's cloud through a local Ollama server unless the classifier entry sets `"allowRemote": true`.
