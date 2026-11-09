# Alternatives

Other pi extensions that protect a session in a nearby way, so you can choose. Checked 2026-11-03 against each project's README, its repository and the npm registry. If a row is wrong or out of date, [open an issue](https://github.com/crisboarna/pi-extensions/issues) and it will be fixed.

pi-account-guard does one thing: before a turn is sent, it checks that the model account belongs to the zone (for example work or personal) of the directory the session works in, and blocks a mismatch. When it cannot decide, it blocks. It does not control tools or commands.

## What was found

A search of npm and GitHub on 2026-11-03 for extensions that check the **account** against a **directory** found none. A search is not proof that none exists. The three below guard something else, and none of their READMEs describes an account or zone check; that is "not established", not "they cannot".

## Choose another extension when

- you want to **control which tools and commands the agent may run**: [pi-permission-system](#gotgenespi-permission-system) or [cc-safety-net](#cc-safety-net);
- you want an **operating-system sandbox** around the agent: [pi-permission-modes](#pi-permission-modes).

They protect a different thing and can be used beside pi-account-guard.

## The ones read

### @gotgenes/pi-permission-system

[gotgenes/pi-packages](https://github.com/gotgenes/pi-packages), package `pi-permission-system`, version 42.0.0, MIT, npm provenance on the registry. Its README says it is a fork of an earlier project.

- **What it is:** allow, ask or deny rules for tool, bash, MCP and skill calls. It protects sensitive paths such as `.env`, asks before reaching outside the working directory, forwards prompts from subagents, and fails closed on an internal gate error or an unparseable bash command.
- **Where it is stronger:** control of what the agent does, and adoption. pi-account-guard does not control tools at all.
- **Not established:** any check of which model account a turn uses. Its README has no account or zone idea and says it holds no model configuration.

### pi-permission-modes

[wynainfo/pi-permission-modes](https://github.com/wynainfo/pi-permission-modes), version 2.7.2, MIT, no npm provenance on the registry.

- **What it is:** switchable modes, each pairing an operating-system sandbox profile with an allow, ask or deny policy for every tool.
- **Where it is stronger:** sandboxing and network prompts, which pi-account-guard does not do.
- **Not established:** any account or model check.

### cc-safety-net

[kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net), version 2.7.2, MIT, npm provenance on the registry.

- **What it is:** it parses a command and blocks destructive ones, and access to secrets such as SSH keys and `.env` files, before the tool call runs. It supports several coding CLIs, pi among them.
- **Where it is stronger:** command analysis, breadth across tools, and adoption.
- **Not established:** any account or model check.

## How this page is kept honest

Every claim comes from the project's own README, repository or registry entry, on the date at the top. "Not established" means the README does not say, which is not the same as "it cannot". Adoption and star counts are left out because they change daily. A page this old gets re-read; `node scripts/comparison-age.ts` lists the pages and their age.
