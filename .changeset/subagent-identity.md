---
"@crisboarna/pi-switchboard": patch
---

Subagent children are identified again under pi 1.4: pi now keeps the system prompt in named sections, so children never found their agent name, could not match their launch decision, and showed as "subagent" in the navigator. Children also record their agent in the live status, launch decisions carry the parent's task number instead of 0, and navigator columns stay aligned when a status icon is coloured.
