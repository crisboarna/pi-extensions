---
"@crisboarna/pi-switchboard": minor
---

First release: model routing for pi. For each request a small local classifier answers three questions (what kind of work, how deep, how risky), your rules turn the answers into a tier, and the tier's strategy picks a healthy model. Requires Node 22.19 or later and pi 1.4 or later.

- **The right model per request.** The first matching rule picks the tier. A confidence gate sends an answer the classifier is unsure about to a fallback tier, so an unsure answer never sends a design task to a small model, and floor rules can raise the tier for risky work.
- **Subagents are routed too.** Each [pi-subagents](https://www.npmjs.com/package/pi-subagents) task gets its own tier-pinned model at launch, within the agent's own limits, and pi-switchboard runs inside every child, so failover and escalation work there as well. Explicit models, agent frontmatter and external runners are never overridden.
- **Work keeps going when a limit hits.** A tier holds several models: a usage limit benches the whole account, a rate limit benches the model, and a tier with nothing left borrows from its neighbour. When every tier is out the turn ends with the earliest reset, and opt-in auto-continue resumes then.
- **A receipt for every choice.** `/tier explain` shows the answers, the rule, the tier and why that member was picked. A live navigator over the subagent children opens with `Ctrl+Alt+W`, and an offline HTML inspector also estimates what a task would have cost on another tier.
- **Private, cheap decisions.** The classifier runs on your machine, request text is redacted before it sees it, and remote classifiers are opt-in.
- **Your models, your rules.** Any provider pi supports, 15 selection strategies, custom rulesets and thresholds; the source names no provider or model.
- **Try it before you trust it.** `/tier tour` is a two-minute walkthrough with sample decisions, `/tier init` proposes a config from your signed-in models and shows the diff before writing it, `/tier try` previews how a request would route (with typed answers when no classifier is available), `/tier doctor` checks the setup and says what to fix, and `/tier dry-run on` classifies and records every request but runs your baseline tier.
- **Classifier setup.** `pi-switchboard classifier detect` finds LM Studio, Ollama or llama.cpp on this machine and lists the decision models each serves; `pi-switchboard classifier setup <lmstudio|ollama|llamacpp|llamacpp-chat>` gets one ready; `pi-switchboard classifier eval` and `/tier eval` test any classifier on 24 labelled requests. `/tier models` is an editor for profiles, tiers and members.
