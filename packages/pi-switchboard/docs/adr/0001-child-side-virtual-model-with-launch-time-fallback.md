---
status: accepted
---

# Subagents run the switchboard virtual model, with a launch-time fallback

Subagent children route through pi-switchboard's own virtual models, so member selection, cooldown, retry failover and escalation also work inside the child. The parent classifies each task when the `subagent` tool is called and writes a tier-pinned model, `switchboard/<profile>.<tier>`, into the task's `model` field; the child's router reads the profile and tier from the model id and does not classify again. pi-switchboard is loaded into every native child through pi-subagents' `registerRequiredChildExtensions`, because local foreground children inherit providers but not virtual models or extension hooks, and it registers its virtual models in the extension factory so they resolve before the child's model does. When that registration is unavailable (another extension holds the session's single slot, or the agent uses an external runner), the parent instead writes a physical member into the `model` field, and the decision records which mode applied.

## Considered options

- **Launch-time physical model only.** Simple and robust, but a child that hits a rate limit or loops on tool failures cannot fail over or escalate, and pi-subagents has had no per-launch fallback models since 0.68.0.
- **Child-side only, failing when blocked.** Purest, but one conflicting extension would break all subagent routing.
- **Passing the tier through `options.extensionBindings`.** Rejected after reading pi-subagents' source: local foreground children never received bindings, and default parallel launches accept a model per task but no binding per task. The foreground gap was fixed upstream (pi-subagents #3049, merged 2026-10-25); the parallel limit remains, so tier-pinned models stay the routing channel and bindings are used only to link children to their launch decisions exactly.

## Consequences

- An explicit model on the call, in agent frontmatter or in `agentOverrides` is never replaced.
- Children do not classify; one decision per task lives in the parent session, which is where the inspector looks for it. Because the child run ID only exists after launch, a link entry written on the tool result joins decisions to child sessions.
- `/model` lists one extra entry per tier of every valid profile.
