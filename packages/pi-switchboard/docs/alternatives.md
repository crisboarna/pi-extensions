# Alternatives

Other pi extensions that overlap with pi-switchboard, so you can choose. Checked 2026-11-03 against each project's README, its repository and the npm registry. If a row is wrong or out of date, [open an issue](https://github.com/crisboarna/pi-extensions/issues) and it will be fixed.

pi-switchboard routes each request to a model tier by complexity, with several models per tier, health tracking and failover to the next account at a usage limit, for the main session and for pi-subagents children. It reads no credential file.

## Choose another extension when

- you want **account failover across many providers** and the most adoption: [pi-multi-account](#pi-multi-account);
- you want a **second, stronger model to review** a weaker one's work, not a router: [pi-advisor-flow](#pi-advisor-flow);
- you want routing **modes and an inspector inside pi**: [pi-model-router](#alexeiledpi-model-router);
- you want routing that is a **virtual model** with keyword rules and a spend cap: [pi-model-router by yeliu84](#yeliu84pi-model-router).

## The ones read

### pi-multi-account

[Sarrius/pi-multi-account](https://github.com/Sarrius/pi-multi-account), version 1.28.1, MIT, npm provenance on the registry.

- **What it is:** an account failover tool, not a router. On a quota or rate-limit error (429, 402, 403 and similar) it moves to another account, keeps the same model where it can, can resume the interrupted turn, and can keep a task armed until an account recovers.
- **Where it is stronger:** failover breadth (it names Anthropic, OpenAI and Codex, Kimi, Cursor, Qwen and Ollama), retry and cooldown handling, resuming after a switch, and adoption.
- **Where it differs from pi-switchboard:** it does not route by the complexity of the request; the README describes keeping a model's quality band. It discovers accounts by reading `~/.pi/agent/auth.json`, as its README says; pi-switchboard reads no credential file.
- **Not established:** how it behaves with pi-subagents children.
- **Check it:** the README sections that list its features and its configuration.

### pi-advisor-flow

[philipbrembeck/pi-advisor](https://github.com/philipbrembeck/pi-advisor), version 0.14.3, MIT, npm provenance on the registry.

- **What it is:** a second-opinion workflow. A working model can ask a stronger advisor model for a review through an `ask_advisor` tool or a manual command, and review gates can start one.
- **Where it is stronger:** it does something pi-switchboard does not do at all, and it has far more adoption than any router listed here.
- **Where it differs:** it does not choose a model for each request or fail over between accounts; its README lists neither.
- **They can be used together:** one decides who does the work, the other asks for a review.

### @alexeiled/pi-model-router

[alexei-led/pi-model-router](https://github.com/alexei-led/pi-model-router), version 0.18.2, MIT, npm provenance on the registry.

- **What it is:** a router that keeps one profile and picks a model and a reasoning effort as the task changes, including between tool-loop requests, with cost, balanced and quality modes and built-in routes for code, debugging, planning and review. A classifier is optional, chosen per profile.
- **Where it is stronger:** a five-tab `/router` inspector in pi, routing modes, and review between tool-loop requests.
- **Where it differs:** its README says it uses one selected classifier, "not voting or classifier failover". Account failover at a usage limit and pi-subagents routing are not established from its README.
- **Check it:** the README section on inspecting routing in pi.

### @yeliu84/pi-model-router

[yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router), version 0.5.4, MIT, no npm provenance on the registry.

- **What it is:** each profile is registered as a pi virtual model; a turn goes to a high, medium or low tier by heuristics, a classifier or keyword rules, within an optional session budget, with a fallback chain on retry.
- **Where it is stronger:** keyword rules and a session spend cap that lowers the tier.
- **Not established:** account failover at a usage limit and subagent routing; its README lists model-unavailable fallbacks.

## Seen, not read

pi-smart-router, @kdejaeger/pi-model-router and @henryqw/pi-task-models also appear in a search of npm for model routing. They are not described here because they were not read.

## How this page is kept honest

Every claim comes from the project's own README, repository or registry entry, on the date at the top. "Not established" means the README does not say, which is not the same as "it cannot". Adoption and star counts are left out because they change daily. A page this old gets re-read; `node scripts/comparison-age.ts` lists the pages and their age.
