# Package README standard

A README is the front door, not the manual: it is the npm page, the pi gallery page and the first file an agent reads before installing. A first-time reader needs, in the first screen: what it is, whether it is for them, and how to start. Reference material goes to `docs/` inside the package.

Adapted from [rpiv-mono's README standard](https://github.com/juicesharp/rpiv-mono/blob/main/docs/readme-standard.md).

## Section order

```text
# @crisboarna/<name>
[badges: npm version, license]
[banner or cover image, then a demo video if there is one]

<lede: 2–3 sentences>

## Install
## Quick start
## What you get
## Configuration      (only if the user configures it)
## Reference          (only if docs/ exists)
## Requirements       (only if not obvious)
## Troubleshooting    (only for failures users hit)
## Limitations
## License
```

Skip a section rather than pad it. Do not invent new top-level sections.

## Rules

- **Lede**: sentence one says what it does in the user's words; sentence two says how (the command, tool or screen it adds); sentence three, if needed, who it is for. No adjectives like "powerful" or "seamless".
- **Install**: `pi install npm:@crisboarna/<name>` and "Restart pi". Nothing else.
- **Quick start**: the shortest path to seeing it work, with what the user sees. A gate (an API key, a local server) belongs here, not under Configuration.
- **What you get**: 5–7 bullets, bold benefit first, then one sentence on how.
- **Configuration**: the file path once, then a table of the settings most people change: setting, effect, default.
- **Reference**: one line per `docs/` page saying what is in it.
- **Troubleshooting**: symptom, cause, fix — only for reported failures.
- **Limitations**: what does not work yet and what is not verified. Honest limits earn trust.
- Images have alt text that describes what the image shows. Keep the source (SVG, tape, fixture) in the package so the asset can be rebuilt.
