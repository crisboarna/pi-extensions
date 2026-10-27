---
"@crisboarna/pi-switchboard": minor
---

`/tier eval [provider/model]` tests any classifier pi knows (a local server, a llama.cpp chat model, or a hosted one such as GPT-6 Luna, after a confirm) on the same 24 labelled requests as `pi-switchboard classifier eval`. Both now also replay the answers at several thresholds and suggest the one that suits the model, and the docs gain a page comparing measured models.
