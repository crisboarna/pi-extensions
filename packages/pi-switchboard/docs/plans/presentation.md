# Presentation plan: making pi-switchboard easy to understand and want

Status: phases 1 to 4 done on 2026-10-26; phases 0 and 5 open. See "Progress" at the end.

## 1. What the popular pi packages do beyond the code

Survey: npm search for `keywords:pi-package` sorted by popularity (12,806 packages), monthly downloads from the npm search API on 2026-10-26, plus a shallow clone of each repository to see which assets and tooling it keeps. Downloads are a rough signal: some numbers include CI installs.

| Package | Monthly downloads | What it adds around the code |
|---|---|---|
| pi-mcp-adapter | 1.57M | Banner. Demo video right under the H1, also set as `pi.video` for the gallery. "Why this exists" story. Comparison table against Pi's built-in MCP with measured numbers (memory, token cost, servers running). "What happens on first run" table keyed by what the user already has. `/mcp-adapter setup` overlay that previews file changes. `init` and `doctor` CLI commands. Eight `docs/` pages. A runnable `examples/` app. |
| pi-web-access | 802k | Banner, badges, demo video (`pi.video`). "Why" section of bold one-line benefits ("Zero Config", "Smart Fallbacks"). Works with no API key on first install. |
| pi-subagents | 558k | Banner, demo video. "Try this first": four plain-language prompts, no config needed. Built-in agents table with a "use it when" column and a one-sentence rule of thumb. "Common workflows" table (Want / Ask naturally). Bundled skills and prompts that teach the agent to use the extension. Ten `docs/` pages, a fleet inspector screenshot. |
| @juicesharp/rpiv-ask-user-question, rpiv-todo | 231k, 152k | A written README standard (`docs/readme-standard.md`): "a README is a front door, not a manual", fixed section order, a 2–3 sentence lede, "What you get" as 5–7 benefit-first bullets, reference moved to `docs/`. Per-package `cover.svg` rendered to `cover.png` and `vertical-cover.png`, set as `pi.image`. Screenshots with full descriptive alt text. An Astro site (docs, blog, search) deployed to GitHub Pages. |
| @plannotator/pi-extension | 107k | Astro marketing site, `.webp` banner and feature images, icons for every host agent. A six-step in-product onboarding tour that replays a real thread from fixtures and never writes to the user's data. Update toasts and feature announcements. Portable guided reviews (guides.show). |
| pi-powerline-footer | 82k | Banner, full-width screenshot, a "Demo settings" section so users can reproduce the screenshot. |
| pi-lens | 77k | Banner, contributor avatars, `docs/`, issue templates, changelog fragments, and an agent skill (`.claude/skills/verify-pi-lens`) with scenario scripts that verify features live before release. |
| @narumitw/pi-usage | 62k | Explicit "Security and privacy" and "Limitations" sections. A documented read-only API that other extensions use (pi-switchboard already reads it). |
| @tintinweb/pi-subagents | 33k | Both `pi.image` and `pi.video`, a FleetView screenshot, an `examples/workflows/` folder. |
| pi-intercom | 29k | Banner. "Why" and "In One Minute" sections. An `AGENTS.md` snippet to paste. Several "Workflow:" sections that show a two-terminal conversation and "what the supervisor sees". Bundled skill. |
| pi-btw, pi-goal-x | 38k, 89k | `pi.image` screenshot, bundled skill (pi-btw), light and dark badges (pi-goal-x). |

Model routers that compete with pi-switchboard (about 20 packages):

| Package | Monthly downloads | Presentation |
|---|---|---|
| @henryqw/pi-task-models | 19k | `pi.image` example screenshot. |
| pi-bifrost | 14k | Social card set as `pi.image`, GitHub Pages site, a small ASCII trace ("You: quick fix the flaky test → tier → pool → model"), `/bifrost init`, a `docs/guide/` folder. |
| pi-router | 8.4k | Long README, no images. |
| pi-multi-account | 6.6k | Long README on account failover and quota, no images. |
| leos-agent | 5.0k | Bundled skills, long README. |
| @alexeiled/pi-model-router, pi-cuttle, @ejstembler/pi-classifier-router | 2.6k, 1.5k, 1.6k | Screenshots. pi-cuttle has an animated pixel-art logo, a "What changes / Why it matters / Who is affected" block, a Verification section and a `docs/GUIDE.md`. |

### Patterns worth copying

1. **A visual in the first screen.** Every package above 80k downloads has a banner and most have a 30–90 s demo video directly under the title. The same video goes into `pi.video` so it plays in the [Pi package gallery](https://pi.dev/packages).
2. **A "try this first" path that costs nothing.** pi-subagents and pi-web-access work with zero config. pi-mcp-adapter shows a table of "what happens on first run" for each starting point.
3. **Why, then proof.** A short problem story, then a comparison table with measured numbers, not adjectives.
4. **Front door, not manual.** README stays short. Reference lives in `docs/`, one topic per page, linked with a one-line summary each.
5. **Tables keyed by user intent.** "Want → ask naturally", "you already have → what happens", "use it when".
6. **The agent learns the extension.** A bundled skill (and sometimes an `AGENTS.md` snippet) so the model can explain and drive the extension.
7. **Guided setup with a preview.** Setup overlays and `init` commands that show the diff before writing.
8. **In-product tours** (Plannotator) that replay canned data and never touch the user's state.
9. **Honesty sections.** Limitations, privacy and verification status build trust.
10. **Reproducible assets.** Source SVGs for covers, "demo settings" for screenshots, scripted verification.

## 2. Where pi-switchboard stands

pi-switchboard already has most of what users would want to see: a live navigator (`/tier watch`), an offline HTML inspector with counterfactuals, `/tier explain`, `/tier init` with a diff, replay with `--reclassify`, cost reports, a footer item. None of it is visible from the README.

Gaps against the patterns above:

- No banner, screenshot, video or gallery fields (`pi.image`, `pi.video`), no `repository`/`homepage` in `package.json`.
- The README opens with the mechanism ("a local decision classifier answers three typed questions"). It does not say what problem it solves for the reader.
- The README is a reference: classifier setup, confidence math, footer config and the full command table all sit in the front door.
- No "try this first" path. The first step needs a local classifier, which is the biggest barrier to adoption.
- No comparison with the 20 other routers, so a reader cannot tell why to pick this one.
- No bundled skill, so the agent cannot answer "why did you use this model?" or help tune rules.
- The repository ([crisboarna/pi-extensions](https://github.com/crisboarna/pi-extensions)) is not public yet, so there is no public URL for images, video or a site.

## 3. Positioning

One-line pitch (draft): **Right model for every step, including subagents, with a receipt for each choice.**

The three advantages to lead with, in order:

1. **It routes the whole tree, not just the chat.** Each pi-subagents child gets its own tier at launch, and pi-switchboard runs inside every child, so failover and escalation work there too. Competitors in the survey route only the main session or only at session start.
2. **It keeps working when a subscription runs dry.** Several models per tier, health tracking, account-level benching on usage limits, model-level cooldown on rate limits, borrowing from the next tier, and quota-aware strategies through pi-usage.
3. **Every decision is explainable.** Typed answers (work, depth, risky) with confidence, the rule that fired, the member and why. `/tier explain`, the navigator, the HTML inspector with "what would another tier have cost", and replay with re-classification.

Supporting points: the classifier runs locally (the decision is free and the request text stays on the machine); dry-run mode lets users see decisions before trusting them; the source ships no provider or model names.

Each claim in the comparison table must be checked against the competitor's current docs before publishing, and the table must carry its date. The keyword counts used during this survey are not evidence.

## 4. Animations, walkthroughs and explanations

Each asset below has a goal, a storyboard and the production method. All terminal recordings use a demo environment (section 5) so they are deterministic, cost nothing and show no real account names.

### 4.1 Hero demo video (60–75 s, `media/demo.mp4`, also `pi.video`)

Goal: in one minute, show the problem, the routing, a failover and the receipt.

| Time | Screen | Caption (burned in, short) |
|---|---|---|
| 0–5 s | Pi session, footer shows `⇄ auto · —` | "One model for everything is either slow and costly, or too weak." |
| 5–15 s | User types "rename foo to bar in utils.ts". Footer animates to `bottom · small-model · 0.94`. Reply streams fast. | "A local classifier reads the request. Small job, small model." |
| 15–28 s | User types "design the caching layer for the pricing API". Footer moves to `top · large-model · 0.91`. | "Design work goes to the strongest tier." |
| 28–42 s | User asks for "three parallel reviewers". Navigator (`Ctrl+Alt+W`) opens: three children, each with its own tier and model. | "Each subagent gets its own tier." |
| 42–55 s | A child hits a usage limit (scripted). Navigator row flashes, account shows "benched 2h", child continues on the next member. | "Limit hit? It moves to the next account, mid-task." |
| 55–68 s | `/tier explain` card, then cut to the HTML inspector: decision timeline and the counterfactual cost column. | "Every choice has a receipt." |
| 68–75 s | Logo, `pi install npm:@crisboarna/pi-switchboard`, `/tier init`. | End card. |

### 4.2 Concept animation: "How one decision is made" (12–15 s loop, SVG/HTML, exported to mp4 and gif)

Goal: replace the ASCII pipeline in the README with something a reader understands in one pass.

1. A request bubble slides in: "add retry to the upload client".
2. Three dials fill one by one: `work: implement (0.88)`, `depth: 1.1`, `risky: no (0.93)`.
3. A rule list highlights the first matching rule; the tier chip `@middle` lights up.
4. The confidence gate is drawn as a bar with the threshold line; the answer clears it (green). A second pass of the loop shows a low-confidence answer that falls below the line and drops to the fallback tier (amber).
5. The tier fans out to its members. Two are greyed (cooling down, labels show the timer). The strategy picks the third; its name pulses.
6. A receipt card drops into a stack: "decision #41 recorded".

Built as one HTML page with CSS animations, driven by real `src/rules` and `src/tiering/decide.ts` output from a fixture, recorded with Playwright's video capture, converted with ffmpeg.

### 4.3 Concept animation: "When a subscription runs dry" (10 s loop)

Three lanes, one per account. Requests flow as dots. Lane A turns red with "usage limit, account benched until 14:00". Its dots re-route to lane B. Then lane B shows "rate limited, model cooling 60 s" and one dot borrows from the tier above. A legend explains the three cases: usage limit benches the account, rate limit cools the model, overload retries first.

### 4.4 Concept animation: "Routing the whole tree" (10 s loop)

A parent node splits into three child nodes. Each child gets a coloured tier badge as it launches (`scout → bottom`, `worker → middle`, `reviewer → top`). One child escalates mid-task (badge moves up one tier, label "escalated: tests failed twice"). Footer text: "pi-switchboard runs inside every child."

### 4.5 Terminal walkthrough clips (8–20 s each, VHS tapes in `media/tapes/`)

| Clip | Shows | Used in |
|---|---|---|
| `init.tape` | `/tier init` proposing profiles from signed-in models, the diff, writing the file | Quick start |
| `dry-run.tape` | `/tier dry-run on`, three prompts, `/tier log` listing what each would have used | "Try it without risk" |
| `explain.tape` | `/tier explain` for one decision, scrolling the reasoning | "Every decision is explainable" |
| `watch.tape` | `Ctrl+Alt+W` navigator: tasks, children, a transcript opening | Subagents section |
| `pin.tape` | `/tier pin @top`, footer change, `/tier pin auto` | Commands doc |
| `report.tape` | `/tier report` with cost by tier and the confidence histogram | Tuning doc |

Each tape has a matching still frame (PNG) for places where video does not play (npm page, some readers).

### 4.6 Inspector walkthrough (browser, 20–30 s)

Recorded with Playwright on a demo session file: open the inspector, click a decision, show the typed answers and the rule, open a subagent transcript, sort the counterfactual cost column. Also produce three annotated stills (numbered callouts) for `docs/inspector.md`.

### 4.7 Interactive playground (static web page)

Goal: let a reader feel the routing before installing anything, and let a user tune rules safely.

- Type a request, or pick one of ten samples. Without a live classifier, the samples carry recorded answers; a "manual" mode lets the user set `work`, `depth`, `risky` and confidences with sliders.
- Paste a config (or pick an example from `examples/`). The page runs the real ruleset and decision code, shows which rule fires, the tier, the member the strategy would choose, and why.
- A threshold slider shows how many sample requests fall to the fallback tier.
- `src/rules` and `src/tiering` import nothing from Node or pi, so they can be bundled for the browser as they are. This must be confirmed with a build, and `selection` must be checked the same way.

Hosted on GitHub Pages with the docs (section 6). Optional in phase 1.

### 4.8 In-product walkthroughs

| Feature | What it does | Pattern source |
|---|---|---|
| First-run notice | After install, with no config, one notification: what pi-switchboard is and "run `/tier init`". Stored in `state.json` like the existing ToS notice. | pi-mcp-adapter first run |
| `/tier tour` | A short guided tour in the TUI over canned decisions (a fixture, like Plannotator's tour). Five steps: footer, `/tier explain`, navigator, a failover replay, the inspector. Writes nothing to the user's state. | Plannotator onboarding tour |
| `/tier try <text>` | Classify a request and show the tier and member it would use, without running a model. Dry-run for one prompt. | pi-subagents "try this first" |
| `/tier doctor` | One screen: classifier reachable and warm, profiles valid, models signed in, pi-usage present, footer configured. Each line has a fix. Wraps `/tier validate`. | pi-mcp-adapter `doctor` |
| Bundled skill `skills/pi-switchboard/SKILL.md` | Teaches the agent to answer "why did you use this model?", read `/tier explain`, suggest rule and threshold changes, and never edit classifiers for a project. | pi-subagents, pi-intercom |

### 4.9 Static images

- `media/banner.svg` → `banner.png` (1100 px wide, like the nicobailon packages) and `cover.png` (1200×630) for `pi.image` and social cards. Keep the SVG source in the repo.
- Architecture diagram (draw.io source + SVG): main session, classifier, rules, strategy, children, health store, decision records.
- Footer screenshot with the exact `powerline.customItems` used ("demo settings").
- Light and dark versions where the image has a background.

## 5. Production setup

- **Demo environment**: a `media/demo/` folder with a demo `pi-switchboard.json`, `PI_CODING_AGENT_DIR` pointing at a temporary directory, and fake account names. The integration test fake host (`test/support/fake-pi.ts`) and `test/support/lmstudio-chat.ts` are the base. A scripted provider that returns fixed replies and raises a usage-limit error on cue makes the failover scene repeatable.
- **Tools**: VHS for terminal clips (not installed; `brew install vhs`). Check that VHS can send `Ctrl+Alt+W`; if not, add a command alias for the navigator in the demo. Playwright (`playwright-cli` is installed) for the inspector and the HTML animations. ffmpeg (installed) for mp4/gif conversion and captions. gifski optional for smaller gifs.
- **A `npm run media` script** that rebuilds every clip and still from tapes and fixtures, so assets stay current when the UI changes.
- **Size budget**: hero mp4 under 8 MB, loops under 2 MB, gifs only where mp4 cannot play.
- **Privacy check** before publishing any asset: no home path, account email, token or real session content in any frame.
- **Recording is also verification.** The TUI navigator, the widget, the tier editor and a real pi-subagents child are not yet verified end to end (README, Known limitations). Recording `watch.tape` and the hero video on a real pi requires those to work, so do the live checks first and fix what they find.

## 6. README and docs restructure

New README outline (front door, about 120 lines):

```text
# pi-switchboard
[badges: npm, license, tests]
[banner]
<lede: 2–3 sentences, the pitch from section 3>
[hero video]

## Install
## Try this first          (dry-run: see decisions before trusting them; /tier try)
## What you get            (6 bold benefit bullets, each linked to a docs page)
## How it decides          (concept animation 4.2, one paragraph)
## Subagents               (animation 4.4, two sentences)
## When a limit hits       (animation 4.3, two sentences)
## Compared with other routers   (table, dated, every cell checked)
## Configuration           (config path, the 3–5 settings most people change, examples)
## Reference               (links into docs/, one line each)
## Privacy                 (current section, kept)
## Limitations             (current section, shortened)
## License
```

Move to `docs/`: `classifier-setup.md` (LM Studio, llama-server, remote classifiers), `configuration.md`, `rules-and-confidence.md` (the threshold tables), `strategies-and-failover.md`, `subagents.md`, `commands.md`, `footer.md`, `inspector-replay-report.md`, `troubleshooting.md` (only failures users hit, symptom → cause → fix), `faq.md` ("does it hurt the prompt cache?", "what does a decision cost?", "can a project change my classifier?").

`package.json`: `repository`, `homepage` and `bugs` now point at the monorepo; add `pi.image` and `pi.video` (raw URLs under `packages/pi-switchboard/media/`), and keywords such as `subscriptions` and `cost`.

Optional later: a GitHub Pages site holding the docs, the playground (4.7) and the walkthrough clips.

## 7. Phases

| Phase | Work | Done when |
|---|---|---|
| 0. Prerequisites | Make crisboarna/pi-extensions public. Run the pending live checks (TUI navigator, tier editor, a real subagent child, `/tier init` against real prices). | Public URL exists. Live checks pass or their fixes are merged. |
| 1. Front door | Banner and cover, README rewrite, `docs/` split, `package.json` gallery fields, comparison table with checked cells. | README fits about 120 lines. Every moved section has a docs page. Gallery fields resolve. |
| 2. Recordings | Demo environment, VHS tapes, hero video, inspector walkthrough, stills, `npm run media`. | `npm run media` rebuilds all assets from a clean checkout. Privacy check passes. |
| 3. Concept animations | Animations 4.2–4.4 from real decision code and fixtures. | Each loop is under 2 MB and its numbers match a real fixture. |
| 4. In-product | First-run notice, `/tier try`, `/tier doctor`, bundled skill, then `/tier tour`. | Unit tests for each; tour writes nothing (test asserts no file changes under the agent directory). |
| 5. Optional site | GitHub Pages with docs and the playground. | Playground runs the bundled ruleset and gives the same tier as the extension for every sample. |

## 8. Decisions

- The comparison describes approaches (decide once per session, decide every turn with one model per tier, rotate accounts) instead of naming packages.
- A new mark: an enamel switchboard panel, brass jacks and a red patch cord routing a request to one tier, set in IBM Plex.
- `/tier try` calls the classifier and accepts typed answers (`work=plan depth=1.8 risky=no`) when none answers.

## 9. Progress

Done:

- **Phase 1, front door**: README rewritten to the standard in `docs/conventions/readme.md`; reference moved to ten pages under `docs/`; banner (light and dark), cover and mark; `pi.image` (cover) and `pi.video` (decision animation) in `package.json`.
- **Phase 3, concept animations**: decision, failover and subagent animations (MP4 and GIF), driven by data the real engine produces (`media/data.ts`), rendered in a pinned Docker image (`npm run media`).
- **Phase 4, in-product**: first-run notice, `/tier try`, `/tier doctor`, `/tier tour` and the bundled `pi-switchboard` skill, with unit and integration tests; `/tier try`, `/tier doctor` and the tour were also run in a real pi (RPC mode) against LM Studio's H2O-Lightning-4B.

- **Phase 2, terminal recordings**: a 60-second hero video (`pi.video`) and six clips (init, dry-run, explain, watch, pin, report) with captions and callouts, recorded from real pi, pi-switchboard and pi-subagents sessions in the media image (`tools/media/stage-server.mjs`, `media/terminal/`), not VHS. Only the classifier's answers and the model replies are scripted. The same scenes served as the live TUI checks: the navigator, the decision view, `/tier models`, and real pi-subagents children routed at launch. They found eight bugs, all fixed with tests, the worst being that an npm-installed package did not load in pi at all.

Open:

- **Phase 0**: make the repository public (the README images and the gallery fields point at `raw.githubusercontent.com`).
- **Phase 5, site and playground**: optional; a WebContainer spike ran the real pi in a browser tab (see the conversation of 2026-10-26).
