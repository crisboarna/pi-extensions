---
"@crisboarna/pi-switchboard": patch
---

`classifier setup --no-eval` keeps the threshold and timeout a classifier already has in the config, and says so, instead of writing the defaults over values an earlier eval chose. A classifier new to the config still gets the defaults.
