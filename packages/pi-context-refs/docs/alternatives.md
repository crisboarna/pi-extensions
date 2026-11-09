# Alternatives

Other pi extensions that touch the same job, so you can choose. Checked 2026-11-03 against each project's README, its repository and the npm registry. If a row is wrong or out of date, [open an issue](https://github.com/crisboarna/pi-extensions/issues) and it will be fixed.

pi-context-refs lets you save context you keep retyping as a named ref (a path, a file, a snippet, or a command or URL) and insert it from a `#` picker as a short placeholder that expands to the real content when the message is sent.

## What was found

A search of npm and GitHub on 2026-11-03 found no extension with named, saved refs inserted through a `#` picker. A search is not proof that none exists. Two extensions do nearby jobs.

## Choose another extension when

- you want a **prompt template that switches model and loads a skill**: [pi-prompt-template-model](#pi-prompt-template-model);
- you want **`AGENTS.md` to include other files** by reference: [pi-context-include](#d3ara1npi-context-include).

## The ones read

### pi-prompt-template-model

[nicobailon/pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), version 0.12.3, MIT, no npm provenance on the registry.

- **What it is:** it adds `model`, `skill` and `thinking` frontmatter to pi prompt templates. A template becomes a slash command that switches to a model, sets a thinking level, injects skill context, runs, and restores the previous model.
- **Where it is stronger:** a template can change the model and load a skill, which refs do not do.
- **Where it differs:** the README shows slash templates. Saved path, snippet, command or URL refs, a `#` picker and expansion at send time are not established from it.

### @d3ara1n/pi-context-include

[d3ara1n/pi-extensions](https://github.com/d3ara1n/pi-extensions), package `pi-context-include`, version 3.0.0, MIT, npm provenance on the registry.

- **What it is:** `@path` syntax for `AGENTS.md`. A line that starts with `@path` includes that file; fenced code blocks are ignored.
- **Where it is stronger:** includes in `AGENTS.md` with relative and absolute paths, which refs do not do.
- **Where it differs:** it targets `AGENTS.md`, not the message you type. Its README shows no command or URL source and no picker.

## How this page is kept honest

Every claim comes from the project's own README, repository or registry entry, on the date at the top. "Not established" means the README does not say, which is not the same as "it cannot". Adoption and star counts are left out because they change daily. A page this old gets re-read; `node scripts/comparison-age.ts` lists the pages and their age.
