---
"@crisboarna/pi-switchboard": patch
---

The warning for a classifier pi does not list now names the real cause, at session start, at the first request and in `/tier validate`: pi's own provider has not listed it (is its server running with the model loaded?), its `classifierProviders` entry lacks it, or pi has no such provider. It no longer suggests credentials or `/login`, which never stop pi listing a classifier. A classifier missing from its `classifierProviders` entry is reported at session start instead of at the first request. `/tier eval` and a failed decision say the same.
