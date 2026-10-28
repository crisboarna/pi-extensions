---
"@crisboarna/pi-switchboard": patch
---

For a classifier that did not answer, `/tier doctor` now says what to check from the error: its key (the provider's `apiKey`, `/login` or its environment variable) when the credentials are missing or refused, the provider when a remote classifier fails otherwise, and the server, with `classifier detect`, only for a local one.
