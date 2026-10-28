# pi-switchboard

Classifier-driven model routing for pi's main session and pi-subagents children. These rules add to the repository `AGENTS.md`.

## Read first

- `GLOSSARY.md` defines profile, tier, rank, member, strategy and the other terms; use them exactly, and add a term there before using a new one.
- `DESIGN.md` is the design of record (architecture in section 3, configuration in 7, selection in 9, records in 10); update it in the same change as behaviour it describes.
- `docs/adr/` holds the decisions that are expensive to reverse; add an ADR instead of reversing one silently.

## Invariants

- The source names no provider, model or account; everything comes from user config. `test/unit/source-scan.test.ts` enforces it.
- Decision records are custom session entries and never enter the model's context.
- Network calls go only to configured classifiers; a classifier that is not local is skipped unless its entry sets `allowRemote: true`.
- Evidence is redacted once, before it reaches a classifier, a session entry or a log.
- A project config may add or adjust profiles only after the user trusts the project, and can never change classifiers.
- Explicit models, agent frontmatter and `agentOverrides` in pi-subagents calls are never overridden.

## Code map

- `src/index.ts` registers commands, renderers and shortcuts; `src/runtime.ts` wires pi events to the engine.
- `src/router/engine.ts` decides each request; `src/rules/` and `src/tiering/` are pure and run without pi or Node.
- `src/selection/` picks a member (strategies, health, cooldowns, quota); `src/classifier/` builds evidence and calls classifiers.
- `src/subagents/` routes pi-subagents launches; `src/live/`, `src/timeline/` and `src/tui/` feed the navigator and inspector.
- `src/cli/` is the `pi-switchboard` command (replay, inspect, report); `bin/` loads it through jiti.

## Testing

- Unit tests (`test/unit/`) cover pure modules with injected clocks, random sources and stores instead of waiting on real time.
- Integration tests (`test/integration/`) load the extension through jiti against the fake host in `test/support/fake-pi.ts`, with `PI_CODING_AGENT_DIR` in a temporary directory.
- `test/support/lmstudio-chat.ts` registers LM Studio chat models as a pi provider for free local end-to-end runs (see the README's Development section).
- `npm run coverage` runs unit and integration tests together (integration imports natively so V8 can map coverage) and fails below 90% lines, branches or functions; `test/unit/all-modules.test.ts` makes every source file count.
- Live checks not yet done are listed in the README under Limitations; remove an entry only after running the check.
- `npm run media` drives the real pi, pi-switchboard and pi-subagents in a terminal for the hero and clips (`media/terminal/`, scenes in `media/terminal/scenes/`); a new scene is also the quickest live check of the TUI. `MEDIA_KEEP=.debug` keeps a scene's sessions and subagent logs.
- From pi's packages import only the entry points pi maps for installed extensions; `npm run smoke:pack` (root) loads the tarball in a real pi to prove it.
- End-to-end suites (`test/e2e/`, `npm run test:e2e`) pack the working tree, install the tarball, and drive the bin and the repository's pinned pi in an isolated home. `cli.test.ts`, `pi.test.ts`, `routing.test.ts`, `failover.test.ts` and `subagents.test.ts` need no server and run in CI.
- The prompt suites use stand-ins in `test/e2e/support/`: `standin-provider.ts`, a pi extension with accounts `alpha` and `beta` of models `small`, `mid` and `big`, whose replies (text, provider errors, delays, tool calls) a test scripts per model with `writeScript`; and `standin-classifier.ts`, a System One server answering from `reply()` or, by request text, `when()`. `standins.ts` opens a fresh pi per test on `switchboard/auto`; check the model that answered and `/tier explain`.
- The model-server suites run when `E2E_SERVERS` names them: `ollama`, `llamacpp`, `llamacpp-chat` and `litellm` (or `docker` for all four, in images pinned in `test/e2e/support/docker.ts`), and `lmstudio` (this machine's LM Studio, whose loaded models are put back afterwards). Run them after changing `src/classifier/`, `src/cli/classifier.ts`, `data/classifier-servers.json` or a `docs/classifier-*.md` guide. On battery a Mac runs the Docker servers several times slower and scores drop, so those suites refuse to start (`E2E_ALLOW_SLOW=1` runs them anyway, with scores that do not compare).
- Each suite writes logs and `results.json` (scores, model digests) to `.git/e2e-runs/<suite>/`; models are cached in `.git/e2e-cache/`, and `E2E_FRESH=1` downloads them again.
