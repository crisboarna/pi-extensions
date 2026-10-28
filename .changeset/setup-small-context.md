---
"@crisboarna/pi-switchboard": patch
---

`classifier setup lmstudio` and `setup llamacpp` load the decision model with an 8,192-token context instead of the model's full 262,144: LM Studio's backend held 12.6 GB for H2O-Lightning-4B, and 4.8 GB with the smaller context, with the same routing. The LM Studio and llama.cpp guides give the same option.
