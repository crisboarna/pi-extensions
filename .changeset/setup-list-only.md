---
"@crisboarna/pi-switchboard": patch
---

While `classifier setup` waits for a server, it only reads the server's model lists. It used to smoke-test the server's preferred decision model on every 2-second poll, which made a llama.cpp router load a decision model nobody asked for.
