---
"@crisboarna/pi-switchboard": patch
---

`classifier eval` and `/tier eval` suggest a `timeoutMs` as well as a threshold: twice the measured median, at least 2000 ms, as `classifier setup` writes. `classifier detect` points to eval for both; its config always said 2000 ms, which cuts off a classifier that answers in 2 to 4 s on every request.
