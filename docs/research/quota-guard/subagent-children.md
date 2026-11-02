# How pi-subagents children start their turns, and what they see of their parent

## Summary

- **The proposed environment marker is not a session-scoped Allowance.** Foreground children share the parent’s process; background children share their runner’s process. Multiple sessions can therefore read and modify the same variable. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/watchdog.md:185–187`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:479–481`
- **Foreground children do not load ambient extensions.** Installing pi-quota-guard globally, or loading it in the parent with `-e`, does not by itself install its hooks in a foreground child. Explicit child extensions or host-required extensions are needed. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md:454–455,479–485`
- **Background children normally discover ambient extensions themselves**, unless extension configuration or a capability ceiling disables discovery. This is not a copy of the parent’s loaded extension instances or CLI arguments. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:212–246`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:439–460`
- **Both native child modes start through `session.prompt()`.** Ordinary first prompts fire child `input` with `source: "interactive"`—not `"extension"` or `"rpc"`. Steering and follow-ups also fire `input` with that default source. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:613–618`; `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1651–1656,1750–1790`
- **Foreground children read live process environment, not a launch snapshot.** The temporary launch patch changes only extension bindings and restores them after startup; it does not isolate arbitrary quota variables. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:246–250`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:164–179,565–579`
- **An async runner captures the parent’s environment at spawn.** A quota marker present then remains in that process after the parent deletes its own copy, unless runner-side code changes it. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:517–536`
- **There are documented alternatives:** versioned `extensionBindings` for launch-specific JSON, required-child-extension registration for loading the guard, and Pi’s session header for persisted parent linkage. None independently proves that a particular parent turn authorized a particular child prompt. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:113`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md:479–485`; `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:5–15,178`
- **Ordinary attached foreground execution blocks the parent**, but foreground children can detach and remain in-process. Consequently, “parent `agent_end` means every foreground child has ended” is not a universal invariant. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:104`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:511–552`

## 1. Which extensions load, and under which agent directory?

### Foreground child

Local foreground children are Pi `AgentSession` objects inside the parent process. They deliberately do **not** load ambient parent extensions. They can load extensions explicitly listed through `extensions` or `subagentOnlyExtensions`. They inherit the parent’s registered providers separately; inheriting a provider does not mean inheriting that extension’s event handlers. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:477–481`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:44–74,497–498`

The launch explicitly computes ambient discovery as:

```js
input.host === "runner" && !toolPlan.disableAmbientExtensions
```

Thus it is always false for the foreground `"parent"` host. The resource loader receives `noExtensions: !launch.ambientExtensions` and the separately constructed explicit extension paths. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:212–246`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:439–460`

**Therefore, parent-only `-e ./quota-guard.ts` is insufficient for foreground enforcement.** The child launch uses its own explicit paths, not the parent’s CLI extension list. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:212–246`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:273–328`

### Background child

A background runner hosts native child sessions and permits ambient discovery by default. Setting the agent’s `extensions` field—including `[]`—disables ambient discovery; listed extensions and child-only paths are then handled explicitly. `capabilityCeiling.denyExtensions` also disables ordinary extensions. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md:454–455,553–568`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-tool-plan.js:290–318`

Background discovery is **fresh discovery under the child’s configuration**, not replay of arbitrary parent `-e` arguments: the child creates a resource loader using its cwd, agent directory, settings manager, and launch-specific additional paths. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:398–400,439–460`

### Agent directory and switches

Both modes call pi-subagents’ `getAgentDir()`. It reads `PI_CODING_AGENT_DIR`, expands a leading `~`, and otherwise defaults to the home/config-directory `agent` directory. That directory is supplied to settings, resources, and `createAgentSession`. The async spawn environment retains `PI_CODING_AGENT_DIR`; the foreground launch does not replace it. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/shared/utils.js:83–92`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:398–400,439–443,528–540`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:517–536`

Settings that affect extension loading include:

- `subagents.defaultExtensions`: supplies an extension allowlist where the agent has none; an empty array disables ambient discovery.
- `agentOverrides.<name>.extensions`: replaces the agent’s extension setting.
- `subagents.defaultSubagentOnlyExtensions`: adds child-only paths without itself disabling ambient discovery.
- A capability ceiling’s `denyExtensions`: suppresses ambient, configured, and MCP-provider extensions.  
  `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/models.md:140–165`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:433–445`

A documented host API, `registerRequiredChildExtensions`, makes specified extensions survive ordinary defaults and `extensions: []`, including nested, detached, resumed, and recovered native launches. A conflicting `denyExtensions` rejects the launch rather than silently dropping the required extension. `requireForAllRunners: true` rejects unsupported external or machine-placed runners. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md:479–485`

## 2. How prompts arrive, and whether `input` fires

### First prompt

The foreground execution path creates a child session and calls:

```js
await created.prompt(`Task: ${task}`);
```

The background runner supplies `Task: ${recoveryTask}` to its child-session driver, which also calls `created.prompt(...)`. The factory’s `prompt` method is simply `(text) => session.prompt(text)`, without source options. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:1394–1433`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/subagent-runner.js:908–911`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/run-child-session.js:592–644`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:613–618`

Pi’s `session.prompt()` runs input handlers with `options?.source ?? "interactive"`. Consequently, ordinary native child tasks fire:

```ts
{ type: "input", source: "interactive", streamingBehavior: undefined }
```

The fact that an extension initiated delegation does not make the child source `"extension"`. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:615`; `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1631–1658`

This is not child input delivered over RPC or as a Pi CLI task argument. Even when a compiled host starts the runner through an RPC-mode bootstrap, the actual native child task still follows the SDK-session path above. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:509–516`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/run-child-session.js:592–644`

### Steering and follow-ups

The child factory exposes `session.steer(text)` and `session.followUp(text)` without source options. Both Pi methods invoke `_queueUserInput`, which invokes input handlers. Their default source is `"interactive"`; while streaming, `streamingBehavior` is respectively `"steer"` or `"followUp"`, otherwise undefined. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:617–618`; `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1750–1790`

Both foreground parent controls and background steering requests route through these methods. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:3731–3745`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/run-child-session.js:617–640`

A structured-output child can receive an additional automatic `created.prompt(STRUCTURED_OUTPUT_FOLLOW_UP)`. This is another `input` interception point, not an invisible continuation. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:1434–1450`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/run-child-session.js:645–660`

### Resumes and subsequent model turns

A retained resume resolves a persisted child session file, constructs a revival task containing the follow-up, and the factory opens the existing session file. Its subsequently submitted native prompt uses the same `session.prompt()` boundary. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-resume.js:598–624,666–679`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:508–513`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/run-child-session.js:643–644`

Ordinary additional model/tool iterations do **not** themselves call `session.prompt()` or emit a new input event: Pi’s agent loop performs those iterations internally. Queued steering/follow-up input is intercepted when submitted, not again every time the loop consumes it. `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1750–1790`; `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:160–212`

Returning `{ action: "handled" }` makes Pi’s prompt method return before starting the model run; it does not throw a quota error. Therefore “no model call” and “subagent reports a specific fail-fast failure” are different requirements. `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1590–1600,1651–1657`

## 3. What happens to `process.env`?

### Foreground: live shared environment

A foreground child is in the parent process. Its launch supplies only this temporary environment patch:

```js
{
  PI_SUBAGENT_EXTENSION_BINDINGS: encodeExtensionBindings(input.extensionBindings)
}
```

with `restoreProcessEnv: true`. It does not snapshot or copy arbitrary environment variables into a child-local environment. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:246–250`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:10–16`

`applyProcessEnv()` remembers previous values **only for keys in that patch**, applies them, and later restores those keys. Startup is serialized from patch application through extension binding/`session_start`; restoration happens before the returned child is prompted. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:149–179,539–579`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:1394–1433`

Consequences for `PI_QUOTA_GUARD_ALLOW`:

- It is not removed or overwritten by pi-subagents’ foreground `restoreProcessEnv`, because that variable is not a patched key.
- A child sees its **current process-wide value**, not the value captured when the child launched.
- If parent or child guard code changes/deletes it, all sessions in that process observe that change.
- It therefore remains available for the whole run only if no code changes it during that run.  
  `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:246–250`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:164–179`

More generally, restoration can overwrite a startup-time change to **a patched key**, because it reinstalls that key’s pre-launch value. It does not restore the entire environment. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:164–179`

### Background: spawn snapshot, then runner-global environment

The async runner’s `env` starts with the parent’s `process.env`, removes inherited extension bindings and Git-routing variables, applies runner-specific values, and sets or deletes the launch-owned parent-session variable. An unrelated `PI_QUOTA_GUARD_ALLOW` is not filtered. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:517–536`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/extension-bindings.js:86–89`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/git-environment.js:1–27`

Thus a marker present at spawn is copied into the runner environment. Deleting the parent process’s copy later does not revoke the runner’s copy. This identifies the environment at **runner spawn**, not necessarily at an individual child’s eventual admission from a queue. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:517–536`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/configuration.md:468–476`

Inside the runner, `childProcessEnv()` supplies extension bindings and MCP-selection values. Unlike the foreground launch, the runner launch does not request restoration. These values are applied to the runner process, which can host many child sessions. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:48–62,246–250`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:565–579`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:479`

## 4. Child and parent identity signals

| Signal | What the source establishes | Contract status |
|---|---|---|
| `PI_SUBAGENT_CHILD=1` | Set by the async runner; causes the ambient pi-subagents entry point to register nothing. Not set for local foreground children. | Documented process marker, **not session identity**. |
| `PI_SUBAGENT_RUNNER_PID` | Set to the runner PID. Compare with `String(process.pid)` to distinguish the actual runner from processes it spawns. | Documented extension guidance. |
| `PI_SUBAGENT_PARENT_SESSION` | Exact launch-owned parent session identity in a dedicated runner. Root/foreground hosts deliberately do not publish a process-global parent identity. | Documented for permission forwarding; not an Allowance. |
| `PI_SUBAGENT_EXTENSION_BINDINGS` | Canonical namespaced JSON belonging to the particular launch. Read in factory or `session_start`; capture into session-local state. | Documented launch option. |
| `ctx.sessionManager.getSessionId()` | Identity of the current child session, not its parent. | Pi public extension context/API. |
| `ctx.sessionManager.getHeader()?.parentSession` | Optional parent session **file path** in the session header. | Pi public header/API; populated by this implementation. |
| Runtime fields such as `parentSessionId`, `runId`, `childIndex`, `nestedParent` | Passed through captured internal child-hook configuration. | Implementation detail; the inspected contracts do not expose the whole runtime object as a general extension API. |

Sources: `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/subagent-runner.js:85–90`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/extension/index.js:224–227,917–921`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:479–481`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/watchdog.md:187`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:113`; `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:223`; `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:5–15,178`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:157–176`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-hooks.js:146–167`.

For normal foreground launches, the executor obtains parent ID and file from the parent’s own `ctx.sessionManager`. The child factory passes the parent file to new session creation; new file-backed sessions have their header patched where necessary, while existing forked/resumed files retain their header. A parent without a persisted session file cannot supply that file linkage. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:3789–3798`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:508–521`

Pi’s `PI_SESSION_ID` and `PI_SESSION_FILE` are documented **shell-tool environment injection**, not general process-wide SDK-session identity. They should not replace `ctx.sessionManager` for identifying an in-process child. `node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md:13–32,47–73`

No listed signal carries an allowed parent-turn identity or proof of admission. Establishing such a contract is **not settled by the source**; it would require a documented per-launch Allowance payload and validation/lifetime rules beyond these identity markers. The existing documented payload transport is `extensionBindings`. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:113`

## 5. Concurrent sessions and parent lifecycle

### Shared-process concurrency is real

The foreground factory maintains a set of live children. Its global `loading` promise serializes **startup only**, not the subsequent child runs. The returned session is prompted outside that startup lock. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:149–150,378–386,577–583,641–645`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:1394–1433`

The documentation explicitly states that multiple Pi sessions can share a root host and that a runner hosts many child sessions. It also supports queued/concurrent workflow children. Therefore a process-wide quota marker cannot distinguish two sessions’ current Allowances in either host type. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/watchdog.md:187`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:479`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/configuration.md:468–476`

If the guard is loaded into a foreground child and implements the same unconditional “set at `agent_start`, delete at `agent_end`” logic, the child’s cleanup deletes the **same variable the parent uses**. This follows from the shared process and the absence of quota-variable isolation—not from a special inheritance mechanism. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:10–16,164–179`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:246–250`

### When parent `agent_end` occurs

For ordinary attached foreground execution, `async:false` blocks the parent. The executor awaits `runSync`; the child driver awaits the child prompt. Pi’s agent loop awaits tool execution before advancing to `turn_end` and ultimately `agent_end`. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:104`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:3789`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:1433–1457`; `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:160–212`

However, foreground execution supports detachment: it publishes a detached receipt and marks the still-live session detached. Documentation also recognizes foreground descendants retained after their direct parent settles. Parent completion is therefore not a universal lifetime bound for in-process descendants. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:511–552`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:663`

Background launches are detached by design; interactive completion can wake the parent later. Non-interactive operation has an auto-drain policy, but that does not turn runner environment into session-local state. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:149–162`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:479`

## 6. Existing state and budget propagation

The package already provides these distinct controls:

- **`toolBudget`**: child tool-call accounting; soft limits nudge finalization, hard limits block selected tools. It is installed into the child runtime. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:111`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/subagent-prompt-runtime.js:628–630`
- **`usageBudget`**: root-only reported token/cost limits. Hard exhaustion prevents later child launches; it does not stop running children, and makes no reservations. This is not a configurable time-window account budget. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:112`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/usage-budget.js:16–40,51–67`
- **Spawn budgets**: cumulative per-session and per-run admission caps; inherited nested run budgets remain authoritative, claims are not refunded, and retained resume reuses its original logical child claim. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/configuration.md:478–497`
- **Capability and thinking ceilings**: inherited runtime restrictions, not usage Allowances. Capability registrations are explicitly session-scoped and propagate to nested/async children and recovery. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:19–31`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:414–445`
- **Extension bindings**: bounded, versioned, child-only JSON. The foreground environment is restored after startup, so extensions must retain their binding locally. External runners and caller-supplied bindings on retained resumes are unsupported according to the documented option contract. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:113`

The inherited runtime projection includes depth, routes, capability/thinking ceilings, fanout budget, and required extensions; it does not automatically include arbitrary extension state or `extensionBindings`. Automatic nested propagation of a quota Allowance is therefore **not supplied by this projection**. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:19–31,246–250`

## Implications for pi-quota-guard

1. **The draft cannot rely on the guard simply being installed in every child.** Foreground enforcement requires explicit child loading or the documented required-child-extension mechanism. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md:454–455,479–485`

2. **The child `input` gate is a real interception point**, including first tasks, steering, follow-ups, and automatic structured-output retry prompts. `source: "interactive"` does not distinguish delegated input from human input. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:615–618`; `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1651–1656,1750–1790`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:1450`

3. **An arbitrary env marker can convey a value, but not a session-scoped lifetime.** Foreground reads are live/shared; background reads initially inherit a spawn-time value and later share runner mutations. Parent cleanup neither reliably revokes detached foreground access nor revokes an async runner’s captured copy. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js:10–16,164–179`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js:517–536`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.js:511–552`

4. **Session-local binding capture is an existing documented transport**, and required extensions can guarantee the receiving guard loads. But bindings do not automatically propagate through arbitrary nested launches, and retained-resume restrictions need explicit treatment; they are not a complete Allowance protocol by themselves. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:113`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md:479–485`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-launch.js:19–31`

5. **Parent file linkage is useful for attribution, not authorization.** The public session header links an optional parent file but carries no parent turn/Allowance identity. What should authorize a follow-up, recovery, or child launched after the original turn is **not settled by the source**; a versioned Allowance contract and tests covering those launch paths would settle it. `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:5–15`; `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md:113`

6. **A child guard must not equate headless session shutdown with process ownership.** Foreground shutdown occurs inside the parent process; background shutdown can leave the runner serving other sessions. The docs explicitly warn extensions against exiting those processes at session shutdown. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md:479–481`

## Sources

Versions verified from manifests: **pi-subagents 0.84.0** and **pi-coding-agent 1.4.0**. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/package.json:2–4`; `node_modules/@earendil-works/pi-coding-agent/package.json:2–3`

Files inspected, wholly or in relevant ranges:

- **pi-subagents 0.84.0**, under `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/`:
  - `package.json`
  - `docs/{agents,configuration,extension-api,models,tool-reference,watchdog}.md`
  - `src/shared/utils.js`
  - `src/extension/index.js`
  - `src/runs/shared/{child-launch,child-session,child-runtime-config,extension-bindings,pi-spawn,child-hooks,child-tool-plan,subagent-prompt-runtime,usage-budget,git-environment}.js`
  - `src/runs/foreground/{execution,subagent-executor}.js`
  - `src/runs/background/{async-execution,runner-child-launch,run-child-session,subagent-runner,async-resume}.js`
- **Pi 1.4.0**, under repo-relative `node_modules/@earendil-works/pi-coding-agent/`:
  - `package.json`
  - `docs/environment-variables.md`
  - `dist/core/{agent-session,resource-loader}.js`
  - `dist/core/extensions/types.d.ts`
  - `dist/core/session-manager.d.ts`
- **Installed Pi agent-core implementation**:
  - `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` — used to establish tool-await/event ordering; its package version was not independently checked.

## Addendum (checked by the map driver, not the research agent)

- pi-switchboard in this repo already imports `registerRequiredChildExtensions` from `pi-subagents/required-child-extensions`. `packages/pi-switchboard/src/subagents/pi-subagents.ts:45-46`
- pi-subagents allows one registration per parent session; a second throws `Required child extensions are already registered for session ...`. `/Users/cris/.pi/agent/npm/node_modules/pi-subagents/src/shared/required-child-extensions.js:71`
- So pi-quota-guard and pi-switchboard cannot each register their own required child extensions for the same parent session as things stand. They would need a shared registration, or a pi-subagents change.
- pi-switchboard already passes per-launch state to children in its own namespace inside `extensionBindings`. `packages/pi-switchboard/src/subagents/binding.ts:3-42`
