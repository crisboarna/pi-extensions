---
"@crisboarna/pi-switchboard": patch
---

`classifier setup lmstudio` loads the model with `--identifier h2o-lightning-4b`. With more than one variant downloaded, LM Studio listed the copy as `h2o-lightning-4b@<variant>`, and setup waited for `h2o-lightning-4b` until its wait ran out.
