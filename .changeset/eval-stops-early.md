---
"@crisboarna/pi-switchboard": patch
---

`classifier eval` and `/tier eval` stop when the warm-up and the first request both fail, as they do when the server is down, its key is missing or it has no System One endpoint, and report the error once. They used to list the same error 24 times and still suggest a threshold. When nothing answers, no threshold is suggested.
