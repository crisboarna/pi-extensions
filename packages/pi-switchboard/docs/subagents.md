# Subagents

With [pi-subagents](https://www.npmjs.com/package/pi-subagents) installed, every child gets its own tier: a quick scan can run on a small model while a review runs on a strong one, in the same parallel call.

## How it works

1. When the model calls the `subagent` tool, pi-switchboard classifies each task of the call (one classifier call per task, in parallel) with the agent's name and tools as evidence.
2. It picks the tier with the same rules as the main session, then applies the agent's limits from `subagents.agents.<agent>`: `minTier`, `maxTier` and `fixedTier`.
3. It writes a tier-pinned model, `switchboard/<profile>.<tier>`, into the task. The call is otherwise unchanged.
4. pi-switchboard is loaded into every native child (foreground, background, nested), so the child picks a member of that tier itself, and fails over and escalates inside the child, capped by `maxTier`.
5. When the call returns, a link entry joins each launch decision to the child's run and session file, so the inspector shows children under the task that launched them.

## What is never overridden

- A task or call that already names a model.
- An agent whose frontmatter, `agentOverrides` or `subagents.defaultModel` pins a model.
- Agents in `subagents.exclude`.
- Agents with an external runner (`claude-code`, `codex-exec`, other `runner.type` agents): they cannot use pi models.

## Child mode and launch mode

- **Child mode** works as above. It is what `subagents.mode: "auto"` (the default) uses, and what `"child"` forces.
- **Launch mode** (`subagents.mode: "launch"`, or under `"auto"` when pi-switchboard cannot load into children) picks a physical member at launch, with an in-flight lease so parallel launches see each other, and writes `provider/model:thinking` into the task. Failover inside the child is then pi's own.

`/tier doctor` says which mode is active and why.

## Accounts

`subagents.accountAffinity: "parent"` (default) runs a child on the account the parent last used for that provider, when the same model exists there. `"none"` lets the child's strategy choose freely.

## Not covered

Workflow-script children (`workflow: true`, `runs.run`, `runs.all`): their script text comes from the model's reply, so no hook can change it.
