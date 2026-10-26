---
"@crisboarna/pi-switchboard": patch
---

Loads when installed with `pi install`. pi installs packages without their peers and maps only pi-ai's main entry points, so the import of `pi-ai/api/typesafe-system-one` failed and pi skipped the extension (and every subagent child failed to start). pi-switchboard now carries its own text-only System One client. The navigator overlay is also framed and padded, so the transcript no longer shows through it.
