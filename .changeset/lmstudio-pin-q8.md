---
"@crisboarna/pi-switchboard": patch
---

`classifier setup lmstudio` downloads and loads the Q8_0 file of H2O-Lightning-4B, the one the guide measured, by name. With `lms get <repo> -y`, LM Studio took the variant it preferred for the memory free at that moment, so a run on a machine that already had Q8_0 could download IQ3_XXS and load that instead. The guide says how to choose a smaller file by hand.
