# Show HN draft

Post only after the checklist in [README.md](README.md) passes. Replace nothing in the text below except to keep it true; every claim is in the claims table.

## Title

```text
Show HN: Three pi extensions: model routing, account guard, context refs
```

That is 72 characters. A Show HN title says what it is and has no adjectives. Link it to the site, <https://crisboarna.github.io/pi-extensions/>, because the site has a live demo that runs in the browser; the repository is linked in the comment.

## First comment

Post this as the first comment, from the same account, straight after the submission.

```text
I use pi (https://pi.dev) for coding and kept hitting three small problems, so I wrote an extension for each. They install separately from npm.

- pi-switchboard routes each request to a model tier by complexity, and hands a subagent to the next account when one hits a usage limit.
- pi-account-guard blocks a turn that would go to a work account from a personal repository (or the other way round) before anything is sent. When it cannot decide, it blocks.
- pi-context-refs lets you save context you keep retyping and insert it from a # picker as a short placeholder that expands when you send.

The site has a demo video for each and a live demo that runs real pi and the extension in a container in the browser: https://crisboarna.github.io/pi-extensions/
Source: https://github.com/crisboarna/pi-extensions

How it is tested, since that is the part I care about: the keystroke flows run in a real pi on a virtual terminal, and there is a mutation canary that breaks the source on purpose to check that the tests can fail. Details: https://github.com/crisboarna/pi-extensions/blob/main/docs/conventions/testing.md

Limits: pi 1.4 up to, not including, 2.0; Node 22.19 or later; Linux and macOS are tested, Windows is not. Each package README says what it reads, sends and starts.

What I would like to hear: a bug, or a false positive from the guard. /guard check, /tier doctor and /ref doctor print what to paste into an issue.
```

## If someone asks

- **"Why three packages?"** Each does one job and installs alone; none imports another. They cooperate only through documented events, and each works without the others ([AGENTS.md, Package boundaries](../../AGENTS.md#package-boundaries)).
- **"Does it send my prompts anywhere?"** Point to the Data and privacy section of the package README. Do not paraphrase it from memory.
- **"How is this different from X?"** Answer only about what you have read in X's repository, and link it. Do not guess.
- **"Is it safe?"** Link the [guardrails](../guardrails.md) and the Scorecard badge; do not say "secure".
