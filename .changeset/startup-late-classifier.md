---
"@crisboarna/pi-switchboard": patch
---

pi-switchboard no longer warns at session start that a llama.cpp chat classifier is not registered when pi's llama.cpp provider simply has not listed the router's models yet. A classifier whose provider pi knows is looked for again at the first request, and warned about only if it is still missing.
