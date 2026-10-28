---
"@crisboarna/pi-switchboard": patch
---

`classifier setup` warns that a classifier is slower than the 4 s decision budget only when its measured median is; it compared the timeout it writes, twice the median, and so warned about a classifier with a 3.7 s median.
