---
"@crisboarna/pi-switchboard": patch
---

`/tier doctor` now waits up to 30 s for each classifier, so a slow one is no longer reported as down, and warns when a classifier answers more slowly than the decision budget (`classification.decisionBudgetMs`), since routed requests would then use the fallback tier.
