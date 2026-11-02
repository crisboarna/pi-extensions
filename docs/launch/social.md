# Social posts

Post only after the checklist in [README.md](README.md) passes, from the maintainer's own accounts. Each post uses the claims table, states a limit, and links the site. No hashtags beyond the one shown, and no numbers that change.

Limits checked by `test/launch-docs.test.ts`: X 280 characters (a link counts as 23), Bluesky 300, Mastodon 500.

## X

```text
Three extensions for the pi coding agent, each installs on its own: pi-switchboard routes requests to a model tier, pi-account-guard blocks a work account in a personal repo before the turn is sent, pi-context-refs expands # placeholders. Demo: https://crisboarna.github.io/pi-extensions/
```

## Bluesky

```text
Three extensions for the pi coding agent, each installs on its own: pi-switchboard (route requests to a model tier), pi-account-guard (block the wrong account before a turn is sent), pi-context-refs (a # picker for saved context). https://crisboarna.github.io/pi-extensions/
```

## Mastodon

```text
Three extensions for the pi coding agent, each installs on its own:

pi-switchboard routes each request to a model tier and moves a subagent to the next account at a usage limit.
pi-account-guard blocks a turn that would go to the wrong account for the directory, before anything is sent.
pi-context-refs saves context you keep retyping and inserts it from a # picker.

Demos and a live try-it: https://crisboarna.github.io/pi-extensions/
pi 1.4 up to 2.0; Windows not tested. Bug reports welcome.
```

## LinkedIn

```text
I use the pi coding agent every day, and three small problems kept coming back, so I wrote an extension for each.

pi-switchboard sends each request to a model tier by complexity, and moves a subagent to the next account when one hits a usage limit.
pi-account-guard stops a turn from going to a work subscription in a personal repository (or the other way round), before anything is sent.
pi-context-refs lets you save the context you keep retyping and insert it from a picker.

They install separately from npm, and each says in its README what it reads, sends and starts. The keystroke flows are tested in a real pi on a virtual terminal, and a mutation check breaks the code on purpose to confirm the tests can fail.

Limits: pi 1.4 up to, not including, 2.0; Windows is not tested.

Demos and a live try-it in the browser: https://crisboarna.github.io/pi-extensions/
Feedback I would like most: a bug, or a false positive from the guard.
```
