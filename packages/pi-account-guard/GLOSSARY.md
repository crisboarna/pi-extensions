# pi-account-guard

Stops a pi session from sending a user turn to a model account that does not belong to the zone of the directory the session works in, so a work subscription is never used by accident in a personal repository.

## Language

### Zones

**Zone**:
A named area of trust that both accounts and places belong to, such as work or personal.
_Avoid_: Profile, context, environment, scope

**Default zone**:
The zone a place falls into when no place rule matches it.
_Avoid_: Fallback zone

**Unknown zone**:
The zone of an account that has no zone tag yet. No place matches it, so its use is always blocked.
_Avoid_: Untrusted, unassigned

**Zone tag**:
The user's statement of which zones an account belongs to. An account can carry several zones.
_Avoid_: Label (multi-pass uses that word for its own display names)

### Accounts and places

**Account**:
A model provider id as pi's model registry sees it, such as `openai-codex-2` or `switchboard`. It stands for the credentials that pay for a request.
_Avoid_: Subscription, sub, provider (alone), login

**Place**:
The directory a pi session works in, resolved to exactly one zone.
_Avoid_: Project, repo, workspace, cwd

**Place rule**:
A user-defined condition on a place's path or git remote that assigns a zone.
_Avoid_: Mapping, path rule

### Enforcement

**Match**:
The check that the place's zone is one of the account's zones.
_Avoid_: Allowed, permitted

**Block**:
The guard's refusal to let a user turn reach a model, or its abort of a turn whose model changed to a non-matching account.
_Avoid_: Deny, reject

**Override**:
An explicit user decision to let turns through despite a failed match: once (one turn) or for the rest of the session. Never persisted.
_Avoid_: Bypass, exception
