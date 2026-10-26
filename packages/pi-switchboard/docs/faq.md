# FAQ

**Does switching models break the prompt cache?**
Only when the model changes. Members are chosen on a new user turn, at subagent launch, on escalation and on failover, never mid-task; `sticky` (the default) keeps the same member across turns; and moving down a tier waits for two consecutive easier turns. Every switch is counted, and decisions that cause a cache miss say so.

**What does a decision cost?**
One call to a local classifier: about 0.2–0.7 s on a laptop with H2O-Lightning-4B, and no tokens from your subscriptions. Remote classifiers are opt-in.

**What leaves my machine?**
Only the request to the model that runs it, as without pi-switchboard. The classifier is local unless you set `allowRemote`. Evidence is redacted before the classifier sees it. pi-switchboard never reads `auth.json` or other credential files.

**Can a project change my classifiers or send my code somewhere?**
No. A project file can only add or adjust profiles, rulesets, selection rules and per-agent limits, and only after you trust the project.

**Does it need a classifier to be useful?**
No. Without one, requests use the fallback tier, and you still get several models per tier, failover across accounts and the decision records. `/tier try` with typed answers shows what a classifier would change.

**Does it work without pi-subagents?**
Yes. Subagent routing switches on when pi-subagents is installed.

**Which providers and models does it support?**
Any model pi can run. The source names no provider or model; everything comes from your config.

**How do I see why a model was chosen?**
`/tier explain` for the last decision, `/tier watch` while work runs, `/tier inspect --open` for the whole session. The bundled skill also lets the agent answer "why did you use this model?" from the records.
