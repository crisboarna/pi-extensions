---
"@crisboarna/pi-switchboard": patch
---

`classifier setup llamacpp` and `llamacpp-chat` no longer tell you to start a server that is already running: with the model already served, or llama.cpp's router already up, setup says so and prints no command to start it.
