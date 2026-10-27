---
"@crisboarna/pi-switchboard": minor
---

`pi-switchboard classifier detect` looks for LM Studio, Ollama and llama.cpp on this machine, lists the decision models each serves (and the chat models a llama.cpp server could serve as classifiers), tests the best one with pi-switchboard's three questions, and prints the config to paste. `/tier doctor` points to it when no classifier is configured or one does not answer.
