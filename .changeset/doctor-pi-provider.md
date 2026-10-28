---
"@crisboarna/pi-switchboard": patch
---

`/tier doctor` no longer sends a classifier from one of pi's own providers, such as `llama.cpp/<model>`, to `classifierProviders`: when that provider does not list the model, doctor says so and asks whether its server is running with the model loaded.
