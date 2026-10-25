# pi-switchboard

Routes each piece of agent work to a model by complexity, using a decision classifier's answers and user-defined profiles.

## Routing

**Profile**:
A named, user-defined mapping from tiers to members, with its own ruleset and fallback settings.
_Avoid_: Preset, plan, subscription

**Tier**:
A named complexity level inside a profile, ordered by an explicit rank.
_Avoid_: Level, class, grade

**Rank**:
The integer that orders tiers within a profile; higher rank means stronger, regardless of tier name.
_Avoid_: Priority, weight

**Member**:
One candidate model (with optional thinking level) inside a tier, from any provider or account.
_Avoid_: Backend, deployment, candidate

**Ruleset**:
A named, ordered list of rules that turns classifier answers into a tier name; a profile references one.
_Avoid_: Policy, mapping

**Tier rule**:
A ruleset entry mapping a condition over answers to one tier. The first matching tier rule wins.
_Avoid_: Rule (alone), mapping

**Floor rule**:
A ruleset entry that, when its condition matches confidently, raises the chosen tier to at least a given tier. All matching floor rules apply.
_Avoid_: Minimum, override

**Tier target**:
What a rule points at: either a tier name or a rank-relative position (such as top or bottom) resolved against the profile's ranks.

**Tier-pinned model**:
A selectable model that stands for one profile and one of its tiers. Choosing it fixes the tier; member selection and failover still apply.
_Avoid_: Tier alias, fixed model

**Pin**:
A manual tier choice that replaces classification for the main session until unpinned; it covers subagents only when requested.
_Avoid_: Lock, force

**Fallback tier**:
The tier a profile uses when the classifier is unavailable or the gating confidence is below threshold.
_Avoid_: Default tier, safe tier

**Baseline tier**:
The tier a profile uses while routing is deliberately inactive (dry-run, before the first decision, classifier disabled). Defaults to the fallback tier.
_Avoid_: Floor, minimum tier

**Direct tier**:
The tier for requests outside the agent loop, such as compaction summaries. Defaults to the lowest rank.

**Launch tier**:
The tier the parent assigns to a subagent task when the subagent is launched. The child starts there and does not classify again; escalation may raise it up to the agent's maximum tier.
_Avoid_: Child tier, inherited tier

**Escalation**:
A move up one rank within a turn, triggered by an escalation rule; it ends at the next user turn.
_Avoid_: Promotion, bump

**Gating confidence**:
The lowest confidence among the choice and yes/no answers that the matched rule references. Score answers never gate; the default rule has none.

## Classification

**Question set**:
The configured questions the classifier answers in one call per decision.

**Classifier chain**:
The ordered list of classifiers tried within one decision; non-local entries take part only when explicitly allowed as remote.
_Avoid_: Classifier pool, fallback classifier

**Evidence**:
The bounded state sent to the classifier: latest request, plan phase, tool outcomes, agent name and tools.
_Avoid_: Context, summary

**Decision**:
One recorded routing outcome: evidence, answers, tier, member and the reason for each choice.
_Avoid_: Routing event, log entry

**Navigator**:
The live in-terminal view of running work: the current task, its subagents, their tiers, models, activity, cost and transcripts.
_Avoid_: Dashboard, fleet view, monitor

**Transcript mirror**:
A bounded, redacted copy of a subagent's conversation that the subagent writes for the navigator, kept for a day after it ends.
_Avoid_: Log, session file

**Inspector**:
A self-contained, offline HTML view of one session and its subagent sessions: tasks, decisions, requests, tool calls, model switches and cost, including counterfactual estimates.
_Avoid_: Viewer, dashboard, export

**Task**:
One user turn, from the user message to the end of the agent run, including every subagent run launched inside it. The unit for cost reports.
_Avoid_: Job, request, session

## Selection

**Strategy**:
The algorithm that picks one member from a tier after the tier is chosen.
_Avoid_: Policy, balancer

**Selection granularity**:
How often a strategy may pick a different member: once per session, once per task, or on every request. A healthy member is never replaced before its granularity allows it.
_Avoid_: Rotation interval

**Borrowing**:
Using a member of a neighbouring tier because every member of the chosen tier is cooling down.
_Avoid_: Overflow, spillover

**Budget**:
A soft limit on tokens or estimated cost for a task or a session. Crossing it warns; it never changes routing.
_Avoid_: Quota, cap

**Account sibling**:
The same model reached through another account of the same base provider (for example a second subscription of one provider). Used for failover only when explicitly enabled.
_Avoid_: Pool member, alias

**Usage ledger**:
The extension's own record of each member's token and cost usage over time, compared against optional per-member budgets when no quota data exists.
_Avoid_: Quota, meter
