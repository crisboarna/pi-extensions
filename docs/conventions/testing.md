# Testing

How to test an extension in this repository, and how to know that a test can fail. Every rule here comes from a failure we had; the gate that enforces what can be enforced is in [guardrails](../guardrails.md).

## Layers

| Layer | Where | What it proves | Run with |
|---|---|---|---|
| Unit | `test/unit` | Pure logic, with fakes | `npm test` |
| Integration | `test/integration` | Modules together; a fake pi host; real pi-tui components fed key bytes | `npm run test:integration` |
| Real TUI | `test/tui` | Real interactive pi in the test process on a virtual terminal: keys in, screen out | `npm run test:integration` and `npm run coverage` |
| Pty smoke | `test/smoke` | The shipped extension in a pseudo-terminal, as a canary | `npm run test:smoke` (CI) |
| RPC and print | `test/smoke` | The extension through pi's RPC and print modes | `npm run test:smoke` (CI) |
| Wire | `test/smoke/wire.test.ts` | Real pi and its own OpenAI client against a server on 127.0.0.1 (`test/support/fake-openai.ts`, no key, no network) that records every request, so what left pi is read from the request body | `npm run test:smoke` (CI) |
| End to end | `test/e2e` | The packed tarballs in the repository's pinned pi, both packages in one pi | `npm run test:e2e` |

Put a new keystroke check in `test/tui`. A fake `ui` cannot show a dialog that loses its question off a small screen, a key that pi handles before your component, or a timer that keeps the process alive; real pi on a virtual terminal can.

## Real-TUI tests

`test/support/virtual-terminal.ts` is a pi-tui `Terminal` drawn into xterm.js. It is the same file in every package (`scripts/checks/copies.ts` keeps the copies identical). Each package's `test/support/tui-session.ts` starts real `InteractiveMode` on it with the package and stub providers loaded.

| `terminal.` | Does |
|---|---|
| `press(keys)`, `type(text)` | Send bytes, or text one character at a time |
| `screen()` | The screen as text; rows end in spaces |
| `waitForScreen(match, timeoutMs?)` | Resolve with the first screen `match` accepts |
| `runCommand(command, marker)` | Type a slash command, press Enter until it runs, wait for `marker` |
| `chooseRow(label)` | Move a pi selector to the row with `label` and press Enter |
| `answer(text)` | Type into an input or editor dialog and press Enter |
| `raw` | Everything pi wrote, escape sequences included |

`TuiSession.start(options)` takes `columns`, `rows` and `env`, and the package's own setup: `library`, `settings`, `before` and `extensions` for pi-context-refs (the order of other extensions around the package), `config` for pi-account-guard and pi-switchboard (and `model` for the latter). Then `ready()`, `editor()`, `waitForEditor(match)`, `terminal`, `project`, `agentDir`, and `close()`.

Name the files a test covers in a header, `// covers: src/pi/commands.ts`. `tui-coverage` fails when a source file that opens a dialog, mounts a component, registers a shortcut or an autocomplete provider, or reads terminal input is named in no header.

`test/support/neighbours.ts` loads pi's own example extensions beside the package, before or after it, to test the shared places: the editor, the `input` event and the status line.

## Rules we learnt

- Never send Ctrl+D on an empty editor, Ctrl+C twice or `/quit`: pi's shutdown ends in `process.exit`, which ends the test run.
- Close an overlay before `close()`; its refresh timer throws "ctx is stale".
- Send keys one at a time. Several keys in one `press()` reach pi as one chunk.
- Wait for the screen, never for a guessed time. Wait for the row you will press, not only for its title: pi draws the title first. A marker must not be part of the command you typed.
- A long path wraps across rows wherever it happens to fall, and CI's temporary paths are shorter than yours. Compare with all whitespace removed on both sides for any line that holds a path. To see CI's paths, run with `TMPDIR=/tmp/ci-like` (create it first).
- Fullscreen is pi's default mode. There PageUp and PageDown reach only an overlay; test page keys in both `tuiMode` settings.
- A dialog is drawn in a few rows, so its question must fit a 24-row terminal. If a dialog's message or list can grow, test it at 24 rows.
- A timer a third-party extension starts can keep the test process alive after the last test. Clear the timers a neighbour started when the session closes, and never leave one running.
- A test that runs `node --test` itself must drop `NODE_TEST_CONTEXT` from the child's environment, or a failure in the child exits 0. `scripts/lib/node-test.ts` does.
- Do not build a regular expression from a string you escaped yourself; CodeQL reports it. Count occurrences with `split`, or write the pattern as a literal.
- Random-input tests use a seeded generator. A failure prints its seed; `FUZZ_SEED=<n>` replays that run.

## Find the flakes before CI does

Run what you wrote beside other work:

```bash
npm run soak                                    # every test/tui suite, 4 copies each
npm run soak -- pi-switchboard --copies 12      # one package
npm run soak -- packages/pi-switchboard/test/tui/tier-editor-keys.test.ts --copies 24 --parallel 12
```

It prints one line per file and the log of the first failing run. A run that does not exit within `--timeout` (120 seconds by default) is killed and counted as a hang, because a suite can pass every test and then never exit.

### Find tests that depend on each other

Load is one way a test fails. Order is another: a test that only passes because an earlier test ran first. Run the suites in a random order:

```bash
npm run soak -- --randomize --suites unit,integration,tui --copies 3
```

Each copy runs its file's tests in a random order from its own seed, and the run prints the seeds. A failure names its seed: replay that exact order with `SOAK_SEED=<seed> npm run soak -- --randomize --copies 1 <test file>`. `--suites` says which folders of `test/` a package target runs (the default is `test/tui`). It needs Node 24; Node 22 has no random order. The nightly run does this over every package (`nightly.yml`), so a test that depends on another shows up the next morning, with the seed to replay.

## Try real third-party extensions

`test/tui/neighbours-keys.test.ts` loads the example extensions pi ships. Extensions people install are different code, so `npm run coexist` runs the package beside real ones:

```bash
npm run coexist                  # install the pins, run every package's test/coexist tests, remove the folder
npm run coexist -- --keep        # keep the temporary folder, to look at what was installed
```

The versions are pinned in `scripts/coexist.json`. The script installs them from the npm registry into a temporary folder outside the repository, with `--ignore-scripts`, and links pi's own packages in from the repository, so the extensions run against the pi under test and there is one copy of it. The repository's `.npmrc` does not apply to that folder, so the script refuses a pin younger than its `min-release-age`, and a pin that is not an exact version. Read what an extension did from what the model received, not from the screen: one of them draws its own prompt in front of the typed text. A package with no licence is not pinned.

## Prove a test can fail

A test that cannot fail proves nothing. Break the source on purpose, run the test, and put the source back:

```bash
npm run mutation-canary                         # every entry of scripts/mutations/*.json
npm run mutation-canary -- --only tier-save-ignores-no
```

An entry is `{ "id", "file", "find", "replace", "tests" }`: `find` occurs once in `file`, and `tests` are test files of the same package that must fail with the change. The script refuses a file with uncommitted changes, runs the tests unchanged first, and restores the file afterwards, also on Ctrl+C. A mutation that survives means the test does not guard what it claims to; fix the test, not the entry. Add an entry whenever you prove a test by hand.

These commands run on demand, not in a hook or in CI.
