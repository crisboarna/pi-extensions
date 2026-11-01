---
"@crisboarna/pi-switchboard": patch
---

The navigator drops terminal control characters from a subagent's name, tier, model and current tool before it draws them, so a child's status file can no longer move the cursor, clear the screen or set the terminal title.
