---
"@crisboarna/pi-switchboard": patch
---

Running `classifier setup lmstudio` again while the model is loaded no longer loads a second copy of it: setup skips the download and load when the server already has the model loaded. `classifier detect` no longer lists LM Studio's extra loaded copies (`model:2`) as models of their own.
