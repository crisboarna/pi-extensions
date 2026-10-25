# Research: can a pi extension tell which credential a request will use, early enough to block it?

**Ticket:** Can an extension identify which pooled credential a request uses?
**Scope:** pi-multiprovider 0.12.0, pi-multi-account 1.26.0, pi-multi-pass 1.12.0, pi core 1.4.0 (`coding-agent` and `ai` packages), and the user's `subscription-status.ts`. Only package source and the READMEs bundled in the packages were read.

**Path prefixes used in citations:**

- `mp/` = `/tmp/pi-scout/pi-multiprovider-0.12.0/package/`
- `ma/` = `/tmp/pi-scout/pi-multi-account-1.26.0/package/`
- `pass/` = `~/.pi/agent/npm/node_modules/pi-multi-pass/extensions/`
- `ca/` = `/tmp/wf-src/pi/packages/coding-agent/src/core/`
- `ai/` = `/tmp/wf-src/pi/packages/ai/src/`
- `ext/` = `~/.pi/agent/extensions/`

## Short answer

- **One account per provider id** (pi-multi-pass, pi-multi-account, plain pi): yes. The account is the provider id of the selected model. Every account change goes through `pi.setModel`, so `model_select` fires before the next request.
- **Pooled under one provider id** (pi-multiprovider): no, not reliably. The account is leased inside the lifted provider stream (`mp/src/lift.ts:169`). That happens after every turn-level hook has run, and nothing is published per lease. The best pre-request signal is `getActiveAccount()` on the `pi-multiprovider:service` event. It returns a value only when a session pin or affinity choice exists, and a cooled-down pinned account is silently replaced by another (`mp/src/service.ts:222-226`).
- **Plain pi can change credential under one provider id.** This happens when the stored credential disappears and the environment takes over (`ai/auth/resolve.ts:70-91`). Pi's public `ModelRegistry` exposes the auth kind and source without secret values, so the guard can detect this kind of change.

## 1. pi-multiprovider 0.12.0

### Where the account is leased

Verdict: inside the provider stream, once per attempt, after pi has already resolved the base provider's ("upstream") auth.

- The README says: "Each request leases an account, resolves that account's auth, and delegates to the original provider" (`mp/README.md:23`).
- The extension replaces the registered provider with a lifted copy. `install()` builds it with `liftProvider(base, service, {...integration, affinityKey, onFailover})` and re-registers it with `pi.registerProvider(lifted)` (`mp/extensions/multiprovider.ts:815-828`). The lift is marked with `Symbol.for('pi-multiprovider.lifted-base')` (`mp/extensions/multiprovider.ts:581`, `:826`).
- It re-lifts on `session_start` and on every `before_agent_start` through `reconcile()` (`mp/extensions/multiprovider.ts:1074-1087`).
- Pi core first runs `prepareRequest`:
  - It resolves the upstream auth (`ca/model-runtime.ts:672`).
  - It runs `transformHeaders`, which is how `before_provider_headers` is implemented (`ca/model-runtime.ts:690`, `ca/sdk.ts:353-354`).
  - Only then does it call `provider.stream(...)`, which is the lifted stream (`ca/model-runtime.ts:715-719`, `:754-755`).
- Inside the lifted stream (`mp/src/lift.ts:140-240`):
  - It computes `excludeAccountIds` (`:153-157`).
  - It calls `service.acquire(...)` (`:169-174`).
  - It resolves that account's auth (`:199`).
  - It calls the real provider (`:240`).
- `acquire` filters enabled, non-cooled, non-excluded accounts (`mp/src/service.ts:181-191`). It prefers the pinned account only if that account is still available (`:222-224`); otherwise the pool strategy picks (`:226`).
- **Failover inside one request:** after a pre-output failure, the loop leases the next account without leaving the stream (`mp/src/lift.ts:184`, `:319`). `mp/README.md:44` covers the stream-safe failover behaviour. The provider id and model do not change, so `model_select` never fires.

Consequences for hooks:

- `before_provider_headers` runs before the lease (`ca/model-runtime.ts:690` precedes `:719`). It sees upstream headers, not the leased account's.
- `before_provider_request` is driven by `options.onPayload`, which the provider must call before sending (`ca/extensions/types.ts:1948`, `ca/sdk.ts:376`, `:424`). Inferred from the code structure: in a lifted stream this runs inside the delegated base provider, so after the lease. Its event has only `payload` (`ca/extensions/types.ts:901-904`), which carries no account identity. This ordering is inferred and was not traced line by line, so treat it as **unverified**.

### Does it expose the leased account before the request leaves?

Verdict: no per-lease exposure. There is only a "session's effective account" query, which is often `undefined`.

- **pi.events:** only two emissions exist:
  - the service announcement (`mp/extensions/multiprovider.ts:696`, re-sent on `session_start` at `:1081`);
  - the integration registration event (`mp/src/register.ts:13`).

  Nothing is emitted per lease.
- **The announcement API** (`mp/src/announcement.ts:54-130`, types at `mp/src/types.ts:282`, `:291-307`):
  - `getActiveAccount(providerId, ctx)` returns `{id, label, authKind}`. It covers the explicit `/switch-account` pin, or the scheduler's last affinity choice when pool affinity is on. Otherwise it returns `undefined` (`mp/src/announcement.ts:57-79`, especially the `pin === undefined || (!pin.explicit && !affinity)` check). The README says the same: "`undefined` means selection is automatic or upstream" (`mp/README.md:286`).
    - On the first turn of a session with affinity and no pin, there is no last selection yet, so the result is `undefined`.
    - It returns `undefined` both for "no pool for this provider" (`integration === undefined`) and for "automatic". It cannot tell a pooled provider from an unpooled one.
  - `resolveActiveAccountAuth(...)` returns the access token. A guard must not use it.
  - `onActiveAccountChanged(providerId, cb)` fires only on `/switch-account` and on pin replay at session start (`mp/README.md:288`, `mp/extensions/multiprovider.ts:1060-1063`, `:1440-1443`). It does not fire on scheduler rotation or failover.
- **`ctx.ui.setStatus`:** no status key is set anywhere in `extensions/` or `src/`. A grep for `setStatus` found no matches.
- **Session entry:** `pi-multiprovider:switch-account` custom entries are written only for `/switch-account` and inherited pins (`mp/src/session-pins.ts:7`, `mp/extensions/multiprovider.ts:1025`, `:1452`, `:1477-1482`). Leases are not recorded.
- **Exported API:** the package exports `MultiProviderService`, `liftProvider`, `MultiAuthStore` and other pieces (`mp/README.md:292`). Consumers are told never to read the private store (`mp/README.md:290`).
- **File:** `multiprovider-auth.json` holds credentials (`mp/README.md:87`). It is off-limits.
- **Even a pin is not a guarantee.** If the pinned account cools down, "another account serves temporarily" (`mp/README.md:158`; code at `mp/src/service.ts:222-226`).

### Can another extension pin or forbid accounts in the pool?

Verdict: not through a supported public surface.

- `/switch-account` is an interactive command (it requires `ctx.hasUI`, `mp/extensions/multiprovider.ts:1371-1374`). `service.pinAccount` is internal; the announcement does not expose it (`mp/src/announcement.ts:81-130`).
- `excludeAccountIds` is a per-integration option (`mp/src/types.ts:257-259`). For stored pools it is fixed by `createManagedIntegration`, which excludes only the upstream account when Pi has no credential for it (`mp/src/managed.ts:234-238`).
- An external extension can register its own integration through the register event. However, when a stored pool exists, "the stored pool wins" (`mp/README.md:307`; `mp/extensions/multiprovider.ts:646-652`).
- Enable or disable lives in the `/multilogin` manager (`mp/extensions/pool-manager.ts:291`, `:594-595`). It is global for the pool, not per place.
- `PI_MULTIPROVIDER_SESSION_PINS` lets a parent pass pins to child sessions (`mp/README.md:125`, `mp/src/session-pins.ts:8`). This only covers children.
- **Unverified:** whether importing `MultiAuthStore` and toggling `enabled` from another extension is safe. It would be a global, persistent mutation, and it contradicts `mp/README.md:290`.

### Does upstream merge make the base `/login` one pool member?

Verdict: yes, optionally.

- With `includeUpstream`, the managed integration adds account `pi:default`, labelled "Pi default", with `authKind: 'custom'` and source metadata "auth.json, environment, or provider ambient auth" (`mp/src/managed.ts:20`, `:204-213`). Its auth is whatever pi core resolved (`mp/src/managed.ts:240-252`). See also `mp/README.md:35`, `:100`, `:123`.
- With "first-account bias", new sessions start on that upstream account when it is included (`mp/README.md:123`).
- Pool-only providers report `{ source: "environment", label: "multiprovider account pool" }` through `getProviderAuthStatus` (`mp/src/multilogin.ts:63-67`; produced by `mp/src/managed.ts:137-139`).

## 2. pi-multi-account 1.26.0

**Distinct provider ids:** yes.

- Slot ids are `${base}-account-${index}`, and slot 1 is the bare base id (`ma/index.ts:2608`, header at `ma/index.ts:10`). Examples are `anthropic-account-3` and `openai-codex-account-5`.
- Native ChatGPT slots follow the same pattern: `openai-account-N` (`ma/openai-chatgpt.ts:56`).
- The README describes the same scheme (`ma/README.md:10`, `:95-96`).
- The base `anthropic` and `openai-codex` providers are re-registered with OAuth overrides (`ma/index.ts:10570-10583`).

**Switching:** through `pi.setModel`.

- `setModelEnsuringVisible` calls `pi.setModel(target)` (`ma/index.ts:4133-4147`). Another call site is at `ma/index.ts:8967`.
- The package warns that failover is impossible if a host lacks `pi.setModel` (`ma/index.ts:12255`).
- So `model_select` fires on every rotation. Its own `before_provider_request` handler belongs to the Cursor bridge (`ma/cursor/index.ts:487`), not to account selection.
- Children spawned without the extension run through a parent-owned loopback "slot proxy". The parent swaps the real token in for a non-secret placeholder (`ma/slot-proxy.ts:1-34`). Subagent children are out of scope for the guard.

**Configuration:** exclusions exist, but only globally. Nothing is per project.

- `excludedProviders` and `excludedModels` live in `~/.pi/agent/provider-failover.json` (`ma/index.ts:23`, `:622`; `ma/README.md:189-190`).
- `/multi-account exclude` keeps a slot out of rotation but does not ban it for other extensions (`ma/README.md:114`, `:137-141`).
- No per-project configuration was found; the config path is fixed under the agent dir.

## 3. pi-multi-pass 1.12.0 (installed)

**One provider id per subscription:** confirmed.

- `subProviderName` returns `` `${entry.provider}-${entry.index}` `` (`pass/multi-sub.ts:2676-2678`).
- `registerSub` registers each one with `pi.registerProvider(name, registration)` (`pass/multi-sub.ts:2848-2887`).
- Pool members are provider names, including the original, e.g. `openai-codex`, `openai-codex-2` (`pass/multi-sub.ts:2294-2296`).
- `MULTI_SUB` env entries get indices at load time (`pass/multi-sub.ts:2614-2646`).

**Pools rotate through `pi.setModel`:** confirmed (`pass/multi-sub.ts:3765`; other call sites at `:3989`, `:4123`, `:4183`, `:7092`, `:7560`). Project `allowedSubs` lives in `.pi/multi-pass.json` (`pass/multi-sub.ts:2344-2353`). It is enforced on `model_select` and `input` (`pass/multi-sub.ts:7617-7630`).

**Cases where the credential changes without the provider id changing:**

- **Re-login into an existing slot.** `/subs login` "replace[s] the rejected credential" under the same name (`pass/multi-sub.ts:7662`; reauthenticate action at `:4325`). Unverified: whether it checks that the new login is the same human account.
- **Token keeper.** It renews and rotates OAuth tokens for the same account (`pass/multi-sub.ts:2855-2861`, `:476-520`). Same identity, so it is harmless to the guard.
- **The original member** (e.g. `openai-codex`) is pi's own login, so the core rules in section 4 apply to it.

No case was found where multi-pass itself serves a different account under the same id without a user action.

## 4. pi core 1.4.0

### Public `ModelRegistry` methods relevant to auth

`ModelRegistry` is the facade on `ctx.modelRegistry` (`ca/extensions/types.ts:337`; class at `ca/model-registry.ts:48`).

| Method | Returns | Secret? |
|---|---|---|
| `isUsingOAuth(model)` (`ca/model-registry.ts:206`) | `true` if the snapshot's auth check type is `"oauth"` (`ca/model-runtime.ts:544-546`) | No |
| `getProviderAuthStatus(provider)` (`ca/model-registry.ts:120`) | `{configured, source?, label?}`. `source` is one of `runtime`, `stored`, `environment`, `fallback`, `models_json_key`, `models_json_command` (`ca/provider-composer.ts:112-116`). The order of checks is runtime key, then stored (auth.json, whether OAuth or key), then models.json or extension config, then the environment check with its label (`ca/model-runtime.ts:647-657`; env-var names as label at `ca/provider-composer.ts:723-737`). | No |
| `hasConfiguredAuth(model)` (`ca/model-registry.ts:85`) | boolean | No |
| `getProvider`, `getRegisteredProviderIds`, `getRegisteredProviderConfig`, `getProviderDisplayName` (`ca/model-registry.ts:124`, `:241`, `:233`, `:190`) | metadata | config may contain the literal `apiKey` |
| `getProviderAuth(provider)`, `getApiKeyAndHeaders(model)`, `getApiKeyForProvider(provider)` (`ca/model-registry.ts:194`, `:89`, `:198`) | the resolved auth, including the secret, plus `source` (`ai/auth/types.ts:108-109`) | **Yes, do not use.** It may also trigger an OAuth refresh (`ai/auth/resolve.ts:173-176`). |

Other surfaces:

- `ModelRuntime.isUsingSubscription` exists (`ca/model-runtime.ts:548-550`) but is not on the facade.
- `CredentialInfo {providerId, type}` is non-secret (`ai/auth/types.ts:39-43`), but only `ModelRuntime.listCredentials` returns it (`ca/model-runtime.ts`, near `:643`). `runtime` is private (`ca/model-registry.ts:49`).
- There is no public `AuthStorage` on the registry. pi-multi-pass reaches into private fields by casting (`pass/multi-sub.ts:391-398`).
- **Staleness:** `isUsingOAuth` and the `stored` status read a cached snapshot (`ca/model-runtime.ts:364-370`, `:400-428`). Request auth is resolved at request time (`ca/model-runtime.ts:672`).

`ext/subscription-status.ts` already uses exactly the non-secret pair: `isUsingOAuth`, then `getProviderAuthStatus().label`, with multi-pass labels read from `multi-pass.json` (`ext/subscription-status.ts:43-68`).

### Can one provider id silently switch from OAuth to an environment API key?

Verdict: only when the stored credential disappears. A failed refresh does not cause it.

- A stored credential owns the provider, and the environment is consulted only when nothing is stored. "No silent env fallback after a failed refresh" (`ai/auth/resolve.ts:27-31`, `:70-91`). A failed refresh throws (`:142`).
- So after `/logout`, an external edit to `auth.json`, or pi-multi-account removing a dead slot (`ma/README.md:14`), the same id resolves from the environment. For `anthropic` that means `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` (`ai/providers/anthropic.ts:28-46`).
- With nothing stored, the credential depends on the pi process's environment, which can differ between directories (for example with direnv). A `models.json` `apiKey` command is resolved at request time (`ca/provider-composer.ts:451`, `:472-475`).
- `isUsingOAuth` and `getProviderAuthStatus` reflect these changes once the snapshot refreshes.

## 5. Conclusion

### Is "Account = provider id" enough for v1?

It is enough for pi-multi-pass, which is the installed package, for pi-multi-account, and for plain pi with one login per provider. In all of these, account changes are model changes, and `model_select` fires.

These setups break it:

1. **pi-multiprovider pools.** Many accounts share one id. The lease, and any failover, happen inside the stream with no event (`mp/src/lift.ts:169`, `:184`).
2. **pi-multiprovider upstream merge.** `pi:default` is one member among stored accounts (`mp/src/managed.ts:204-213`).
3. **pi-multiprovider virtual providers.** The virtual id maps to several backing providers (`mp/README.md:126-148`). This is related to the deferred switchboard question.
4. **Auth-source change under one id.** `/logout` or a missing stored credential lets the environment, `models.json` or a command take over (`ai/auth/resolve.ts:70-91`).
5. **Re-login into the same id with a different human account.** This covers pi `/login` and multi-pass `/subs login` (`pass/multi-sub.ts:7662`). It cannot be detected without reading credential claims.
6. **claude-bridge.** It uses the Claude Code CLI's login. Not in these sources, so **unverified**.

### Identity schemes that would cover more, and their cost

- **A. Provider id only (current v1).**
  - Cost: none.
  - Covers: everything except items 1-6.
- **B. Provider id + auth kind/source.**
  - The key is built from `isUsingOAuth` plus `getProviderAuthStatus().source` and `label`, for example `anthropic:oauth` or `anthropic:env:ANTHROPIC_API_KEY`.
  - Cost: low. The calls are synchronous, public and non-secret, and `subscription-status.ts` already uses the same pair.
  - Adds: item 4, which turns an unseen change into an unknown-account block. Item 1 becomes detectable through the `multiprovider account pool` label (`mp/src/multilogin.ts:63-67`), but only for pool-only providers.
  - Still blind to: items 1-3 when an upstream credential exists, and item 5.
- **C. B + pool detection + "pooled means the strictest member".**
  - The guard detects a lifted provider with `getProvider(id)?.[Symbol.for('pi-multiprovider.lifted-base')]` (`mp/extensions/multiprovider.ts:581`, `:826`). It then treats the provider as allowed only if every enabled pool member is allowed for the place. Optionally it can also require a `/switch-account` pin seen through `getActiveAccount`.
  - Cost: medium. Listing members needs the pool snapshot, which is not exposed through the announcement. The guard would have to hard-code the private symbol, or ask the user to tag every member manually.
  - A pin does not stop cooldown substitution (`mp/src/service.ts:222-226`).
  - Covers: items 1-2 conservatively.
- **D. Upstream event contract in pi-multiprovider.**
  - For example, an `account_lease` hook that may veto, or support for externally contributed `excludeAccountIds`, carrying `{providerId, accountId, label}` before `resolveAuth` (`mp/src/lift.ts:169-199`).
  - Cost: an upstream PR and a version dependency.
  - Covers: items 1-3 exactly, including failover inside a request.
- **E. The guard wraps the lifted provider itself.**
  - Cost: high and fragile. It fights pi-multiprovider's re-lift on every `before_agent_start` (`mp/extensions/multiprovider.ts:1084-1087`, `:795-831`).

### Recommendation

1. Upgrade v1's Account key to scheme B. It is cheap and closes the silent auth-source change (item 4).
2. Add pool detection from scheme C as an unknown-account or strictest-member rule, so pi-multiprovider pools fail closed.
3. Record scheme D as the path to exact pooled-account identity if pi-multiprovider is ever installed. It is not installed now.
4. Re-login into the same slot under a different identity (item 5) stays out of reach without reading secrets. Record it as a known gap.
