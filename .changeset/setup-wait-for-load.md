---
"@crisboarna/pi-switchboard": patch
---

`classifier setup llamacpp-chat` waits until llama.cpp's router lists the model as loaded before it says so and writes the config. The router answers a load at once and loads in the background, and pi started in between found no model and reported the classifier as missing for the whole session.
