---
status: accepted
---

# An Account is a provider id plus its auth source

The guard identifies an Account by the model's provider id together with the auth source pi resolves for it, not by the provider id alone. In plain pi, one provider id can quietly change credentials: after `/logout`, or when the stored login disappears, an environment variable or a `models.json` key takes over under the same id. Keying on the provider id alone would carry a work tag over to whatever key the environment happens to hold. With the source in the key, that change turns into an untagged account, which is Blocked and asks to be tagged. The guard builds the key at every check from public calls that return no secrets (`isUsingOAuth`, `getProviderAuthStatus`). It never reads credential material.

## Considered options

- **Provider id only.** Rejected: it misses an auth-source change under one id, which is a realistic accident.
- **Provider id only, with the tagged source stored as tag metadata.** The effect is the same, but the source becomes a hidden second identity. Rejected because it is less clear.
- **Fingerprinting secrets (API key hashes, OAuth account claims).** This would also catch a re-login as a different person and a direnv-swapped key under the same variable name. Rejected for v1: it reads secrets, it can trigger an OAuth refresh, and it goes beyond what the accidents-only threat model needs.
- **Failing closed on pooled providers (pi-multiprovider).** Rejected: it depends on a private marker, and pi-multiprovider is not installed. Pools are detected only to warn. The exact fix would be an upstream lease-veto hook.

## Consequences

- The auth source is one of `oauth`, `stored-key`, `env:<VAR>`, `models-json-key`, `models-json-command`, `runtime` or `fallback`. A `models.json` command is never stored or shown, because it may contain vault paths or tokens.
- Providers whose real login is outside pi need their own resolver. claude-bridge is the first. Its source is the Claude Code environment key variable if one is set, else the resolved `CLAUDE_CONFIG_DIR`. Bedrock, Vertex and `apiKeyHelper` setups map to one generic `claude-code` source.
- One provider id can need several tags, one for each source. In return, a new source always starts in the Unknown zone.
- Known gaps: a re-login as a different person under the same id, a direnv-swapped key under the same variable name, and an `auth.json` edit made outside pi, which the guard sees one snapshot refresh late.
