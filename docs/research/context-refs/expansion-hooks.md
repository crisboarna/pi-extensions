# Expansion hooks: getting a ref's Expansion to the model while the transcript shows a Placeholder

Research for [#164](https://github.com/crisboarna/pi-extensions/issues/164) on the context-refs map ([#162](https://github.com/crisboarna/pi-extensions/issues/162)). The choice of route is left to grilling ticket [#173](https://github.com/crisboarna/pi-extensions/issues/173).

All findings are for pi 1.4.0 as installed in this repository. Source paths are relative to `node_modules/@earendil-works/`. "Observed" means a real-pi run described in [Method](#method); "source-only" means read from the code but not run.

## Answer

No single hook does everything. Each route trades one thing for another:

- **(a) `input` transform plus `registerMarkdownTransformer`.** The model gets the Expansion in every mode, including steer and follow-up messages. The prompt cache stays stable. The live transcript and a resumed transcript show the compact Placeholder. But the Placeholder cannot be expanded on demand, and every other surface shows the full Expansion: the steering queue line, up-arrow history after resume, the `/fork` selector and the editor after a fork, HTML export, RPC and JSON events, and the compaction input.
- **(b) Hidden side-car custom message from `before_agent_start`.** Everything except the model shows the Placeholder. Steer and follow-up messages lose the Expansion, because `before_agent_start` does not fire for them. Sending the side-car from `input` instead fixes that, but in pi's default `one-at-a-time` queue mode it costs one extra model request per message.
- **(c) A custom message with an expandable renderer.** Pi's tools-expanded toggle (ctrl+o, `ctx.ui.setToolsExpanded`) does drive custom message renderers. A renderer that returns a `MouseRegion` can also expand one message on a click, in fullscreen mode only. Used as a visible side-car on top of (b) (route "bc" below), this is the only tested display that is compact, expandable and still keeps a real user message. Used to replace the user message, it breaks too much: `/fork` cannot select the prompt, history after resume skips it, the steering queue line disappears, and in print and JSON modes the prompt is never sent at all.
- **(d) `context` event.** The model gets the Expansion on every request, steer and follow-up included. Nothing is stored. The transcript, history, `/fork`, export and every event show only the Placeholder, and so does the compaction input. The prompt cache stays stable only while the Expansion is byte-identical on every request. A Dynamic ref, or a File ref whose file changed, changes every earlier message on every request (observed: request N differed from request N-1 at message 0). Resume works only while the extension is loaded and can resolve the Placeholder again.
- **(de) `context` plus a snapshot entry.** This variant was added to the four asked for. The Expansion is computed once on `input`, saved with `pi.appendEntry`, shown by `registerEntryRenderer` as an expandable card, and inserted again by the `context` event. It fixes (d)'s cache and resume problems (observed byte-stable with Dynamic content, also after resume). The compaction input still sees only Placeholders, export does not show the snapshot, and the card shows before the user message, not after it.

The only routes that put the Expansion into the compaction summary, the HTML export and a resume without the extension are the ones that store it as a message: (a), (b), (bc) and (c).

## Method

Throwaway files in the session scratch space, never in the repository:

- **Stub provider:** adapted from [`stub-provider.ts`](../../../packages/pi-account-guard/test/support/stub-provider.ts). Every request's full `TranscriptContext`, which is what the provider serializes, is appended to a JSONL log. The reply is `stub reply <n>`. An optional delay keeps a run open, so steer and follow-up messages land mid-run.
- **Probe extension:** one route per run, picked by an environment variable. The Placeholder is `[Context Ref #N]`. The Expansion is a three-line `<context-ref n="N" name="demo.txt">…</context-ref>` block. A flag adds a per-call counter to the Expansion, so it behaves like a Dynamic ref.
- **Isolation:** pi ran from `node_modules/.bin/pi` with `-ne`, `PI_OFFLINE=1`, a fresh `PI_CODING_AGENT_DIR` and `--session-dir` under a temporary directory, and credential variables removed. TUI runs also had a temporary `HOME` and `-ns -np -nc`. `compaction.keepRecentTokens` was set to 10 so `compact` had something to summarise. No `auth.json` was read.
- **RPC sequence, per route:** prompt with a Placeholder; a prompt without one; a slow prompt with a Placeholder, then `steer` and `follow_up` with Placeholders; `get_messages`, `get_fork_messages`, `export_html`, `compact`; another prompt; `fork` from the first user message. Then a new process with `--session <file>` sends one more prompt. Each request was compared with the previous one, message by message, as JSON.
- **Print and JSON modes:** `pi -p`, then `pi --continue -p`, then `pi --export <file>`, plus `pi --mode json`.
- **TUI:** real interactive pi in a private tmux server, in fullscreen mode (the default). The driver typed a prompt, pressed up-arrow, toggled ctrl+o, and clicked by writing SGR mouse sequences. It also steered mid-run, ran `/export`, quit and resumed with `-c`, then used `/fork`, and saved `tmux capture-pane` screens after each step. [`interactive-block.test.ts`](../../../packages/pi-account-guard/test/smoke/interactive-block.test.ts) drives pi over RPC's extension UI protocol, not a pseudo-terminal, so the TUI checks used tmux instead.
- **HTML export:** every export was rendered in headless Chrome (`--dump-dom`), because the export embeds the session as base64 JSON and renders it client-side (`pi-coding-agent/dist/core/export-html/index.js:105`).

The heart of each probe:

```ts
// (a)
pi.on("input", (e) => (hasPlaceholder(e.text) ? { action: "transform", text: expandAll(e.text) } : { action: "continue" }));
pi.registerMarkdownTransformer((md) => md.replace(EXPANDED, (_m, n) => `[Context Ref #${n}]`));
// (b); (bc) is the same with display: true and a registerMessageRenderer("context-ref", ...)
pi.on("before_agent_start", (e) =>
	e.messageType === "user" && hasPlaceholder(e.prompt)
		? { message: { customType: "context-ref", content: expansionsOnly(e.prompt), display: false } }
		: undefined,
);
// (c)
pi.on("input", (e) => {
	if (!hasPlaceholder(e.text)) return { action: "continue" };
	pi.sendMessage({ customType: "context-ref-prompt", content: expandAll(e.text), display: true, details: { placeholderText: e.text } },
		e.streamingBehavior ? { deliverAs: e.streamingBehavior } : { triggerTurn: true });
	return { action: "handled" };
});
// (d)
pi.on("context", (e) => ({ messages: e.messages.map(expandPlaceholdersInUserMessages) }));
```

## Shared mechanics

These facts hold for every route.

- `input` fires before template and skill expansion. When pi is idle, its result starts a run (`pi-coding-agent/dist/core/agent-session.js:1652`). While pi is streaming, the result is queued as a steer or follow-up message instead (`agent-session.js:1664-1674`, `1752-1766`). The queued text is what the "Steering:" and "Follow-up:" lines show (`interactive-mode.js:3834-3846`). It is also what option+up puts back into the editor (`agent-session.js:1944`, `interactive-mode.js:3852`).
- `before_agent_start` runs only when a run starts (`agent-session.js:1480-1488`). Queued steer and follow-up messages go straight into the agent's queues (`agent-session.js:1795-1820`) and never pass through it. Its returned message is placed after the user message (`agent-session.js:1505-1523`).
- A custom message reaches the model as a `user`-role message (`pi-coding-agent/dist/core/messages.js:89-96`). The compaction input is built by the same `convertToLlm`, without the `context` event (`pi-coding-agent/dist/core/compaction/compaction.js:523`; `compaction/utils.js:113`).
- The `context` event gets a structured clone of the messages for each request and stores nothing (`pi-coding-agent/dist/core/extensions/runner.js:1006-1008`; `pi-coding-agent/dist/core/sdk.js:277-281`).
- The live editor adds the raw submitted text to up-arrow history, not the `input` result (`interactive-mode.js:2679`, `2695`). After resume, history is rebuilt from stored `user` messages only (`interactive-mode.js:3168-3172`, `3381-3385`).
- `/fork` lists stored `user` messages only (`agent-session.js:3425-3431`). After a fork, the editor holds the stored text of the chosen message (`pi-coding-agent/dist/core/agent-session-runtime.js:194`; `interactive-mode.js:4568`).
- ctrl+o (`app.tools.expand`) calls `setToolsExpanded`, which expands every transcript child that has `setExpanded` (`interactive-mode.js:2419`, `3698-3712`, and `isExpandable` at `99`). `CustomMessageComponent` passes `expanded` to the registered renderer (`components/custom-message.js:26`, `52`). `UserMessageComponent` has no `setExpanded` (`components/user-message.js:10-37`), so ctrl+o never reaches a user message.
- In fullscreen mode, mouse events reach transcript components, and `MouseRegion` adds click handling around any component (`pi-tui/dist/components/mouse-region.js:13-16`). Regular mode leaves the mouse to the terminal (`pi-coding-agent/docs/tui.md:56-62`).
- The HTML export, from `/export`, RPC `export_html` or `--export`, renders a user message's full stored text (`export-html/template.js:1263`). It renders a custom message's raw content under a `[customType]` label, with no message renderer. `display: false` messages are marked "Hidden in terminal" and hidden until the viewer turns hidden messages on (`template.js:1335-1339`, `template.css:795`). Custom entries from `pi.appendEntry` are not rendered.
- Print mode prints only the final assistant text (`pi-coding-agent/dist/modes/print-mode.js:110-125`). JSON and RPC modes emit `message_start`/`message_end` for user and custom messages, and `entry_appended` for custom entries (`pi-coding-agent/docs/json.md:122`). Observed: the `input` event's `source` is `"interactive"` in print and JSON modes and `"rpc"` in RPC mode.
- Steer and follow-up queues default to `one-at-a-time` (`pi-coding-agent/dist/core/settings-defaults.js:6-7`; `pi-agent-core/dist/agent.js:73`). Each queued message then gets its own model request (`pi-agent-core/dist/agent-loop.js:191-200`).

## Route (a): `input` transform plus Markdown transformer

- **Model:** the Expansion inline in the user message, for prompts, steer and follow-up (observed, RPC requests 1-5).
- **Transcript:** the transformer turned the stored Expansion back into `Review [Context Ref #1] please`, both live and after `-c` (observed). The transformer gets `(markdown, { messageType, isStreaming, availableWidth })` and no expanded state (`pi-coding-agent/dist/core/extensions/types.d.ts:1160-1165`). It also runs on assistant Markdown (observed in the probe log).
- **Expand on demand:** not possible through pi. ctrl+o left the user message collapsed (observed). Flipping a flag that the transformer reads had no effect until something re-rendered the message. A terminal resize did, after which that message stayed expanded until the next re-render (observed). The cause is that `Markdown` caches its output by text and width (`pi-tui/dist/components/markdown.js:205-210`).
- **Steer and follow-up:** the model gets the Expansion. The queue line showed `Steering: steer with <context-ref n="3" name="demo.txt">`, the raw first line of the Expansion (observed). Option+up would put the full Expansion back into the editor (source-only).
- **Up-arrow:** live, it recalled `Review [Context Ref #1] please`, the raw editor text. After resume, it recalled the full Expansion (observed).
- **`/fork`:** the selector listed the Expansion text, and after the fork the editor held the full Expansion (observed in the TUI and in RPC `fork`).
- **Export:** full Expansion in the user message (observed).
- **Compaction:** the summary input shows `[User]: Review <context-ref …>…</context-ref> please` (observed).
- **Resume:** the stored Expansion reaches the model; the request after resume was prefix-identical (observed). Without the extension, the transcript shows the full Expansion (source-only).
- **Prompt cache:** every request's messages began with the previous request's messages byte for byte (observed, all 5 turns and after resume).
- **Modes:** print printed `stub reply 1`. JSON and RPC `message_end` events, `get_messages` and the session file all carry the Expansion (observed).

## Route (b): hidden side-car from `before_agent_start`

- **Model:** the user message `Review [Context Ref #1] please`, then a second `user`-role message holding the Expansion (observed).
- **Transcript:** Placeholder only. The side-car is not drawn, and ctrl+o does nothing (observed).
- **Expand on demand:** none.
- **Steer and follow-up:** the model got `steer with [Context Ref #3]` with no Expansion (observed, RPC requests 4-5). Workaround: in `input`, when `streamingBehavior` is set, call `pi.sendMessage(sidecar, { deliverAs })`. The side-car is then queued before the user message. In `one-at-a-time` mode it was sent in a request of its own, answered by the model, and the steer message followed in the next request: 10 model requests instead of 8 (observed). With `steeringMode` and `followUpMode` set to `"all"`, the side-car and the user message went out in one request, side-car first (observed).
- **Up-arrow:** Placeholder, live and after resume (observed).
- **`/fork`:** selector and editor show the Placeholder (observed). The side-car is a child of its user message in the session tree, so forking before that message drops it as well (observed in the session entries). Sending the Placeholder text again recreates the side-car only if the extension can still resolve that Placeholder.
- **Export:** the user message shows the Placeholder. The side-car is shown as `[context-ref] · Hidden in terminal`, hidden by default (observed).
- **Compaction:** the summary input has the Placeholder line and, as a separate `[User]` block, the Expansion (observed).
- **Resume:** the side-car is stored, so the model gets it without the extension (observed with the extension loaded; source-only without it).
- **Prompt cache:** prefix-identical across all turns (observed).
- **Modes:** the session file has a `custom_message` entry with `display: false`. JSON and RPC emit it as a `custom` message with `display: false` (observed). Print printed the reply only.

## Route (bc): visible side-car with an expandable renderer

This is (b) with `display: true` and `registerMessageRenderer("context-ref", …)`. The renderer returns a `Box` inside a `MouseRegion` that switches between a one-line summary and the full Expansion.

- **Transcript:** `Review [Context Ref #1] please`, then `[Context Ref] demo.txt (4 lines) - click or ctrl+o to expand` (observed).
- **Expand on demand:** ctrl+o expanded and collapsed every side-car, together with all tool output (observed). A click on the card expanded and collapsed only that card (observed in fullscreen mode). Resume redrew the cards through the renderer (observed).
- **Export:** the side-car's full content under a `[context-ref]` label, not hidden; the renderer is not used (observed).
- Everything else is the same as (b), including the missing Expansion for steer and follow-up and the same workaround (observed).

## Route (c): custom message instead of the user message

- **Model:** a `user`-role message with the Expansion inline (observed).
- **Transcript and expand on demand:** the renderer showed `Review [Context Ref #1] please` on the user-message background. ctrl+o or a click showed the full Expansion (observed).
- **Steer and follow-up:** `sendMessage(…, { deliverAs })` delivered both, and the model got the Expansion (observed). The TUI showed no "Steering:" line, because the message never enters pi's text queues (observed). Option+up clears the agent queues too, so it would drop a queued (c) message without putting it back in the editor (`interactive-mode.js:3820-3830`, `agent-session.js:1944-1952`; source-only).
- **Up-arrow:** live, the Placeholder. After resume, nothing: custom messages are not added to history (observed; `interactive-mode.js:3123-3130`).
- **`/fork`:** these prompts cannot be selected. The TUI said "No messages to fork from", and RPC `get_fork_messages` listed only the one prompt without a Placeholder (observed).
- **Export:** a `[context-ref-prompt]` block with the full Expansion (observed).
- **Compaction:** the Expansion inline (observed).
- **Prompt cache:** prefix-identical (observed).
- **Other extensions:** `before_agent_start` got `messageType: "custom"` and no `prompt` (observed), so a handler that reads the user's prompt sees nothing.
- **Modes:** RPC `prompt` and `steer` answered `{"disposition":"handled"}` although a turn ran (observed). In print and JSON modes the prompt was lost. There was no model request and no stored message, print printed nothing, and the JSON stream held only the session header (observed). Print mode awaits `session.prompt()` and then disposes the runtime (`print-mode.js:105`, `142`), and the run that `sendMessage` starts is never awaited.

## Route (d): `context` event

- **Model:** the Expansion inline, for prompts, steer and follow-up (observed, RPC requests 1-5 and after compaction).
- **Transcript, up-arrow, `/fork`, export, events, session file:** the Placeholder only, live and after resume (observed). Nothing to expand.
- **Compaction:** the summary input has only `[User]: Review [Context Ref #1] please` (observed). Kept messages after the cut are still expanded on later requests (observed).
- **Resume:** worked here because the probe resolves `#N` the same way in every process. A real extension needs the Placeholder-to-Ref mapping stored somewhere. Without the extension, the model sees bare Placeholders (the session holds nothing else; observed).
- **Prompt cache:** prefix-identical when the Expansion was the same every time (observed). With the per-call counter, every request differed from the previous one at message 0, the first user message (observed, 8 of 8 requests). Any Dynamic ref, or a File ref whose file changes, would do the same.
- **Modes:** JSON and RPC events and `get_messages` show the Placeholder only (observed).

## Route (de): `context` event plus a snapshot entry

- **What it does:** `input` appends `pi.appendEntry("context-ref-snapshot", { placeholderText, expandedText })`. The `context` handler reads the snapshots from `ctx.sessionManager.getBranch()` and replaces any user message whose text matches. `registerEntryRenderer` draws the card.
- **Model and cache:** the Expansion inline for prompts, steer and follow-up. Requests were prefix-identical even with the per-call counter, including after resume (observed).
- **Transcript:** an expandable card (ctrl+o and click, observed), drawn before the user message, because the entry is appended while `input` runs. For a steer message, the card appeared at the moment of steering, ahead of the assistant reply that was streaming (observed).
- **`/fork`:** forking before a steered message kept that message's card as an orphan, because the card was appended earlier on the branch (observed). Resending the same text matched the orphan by exact text.
- **Export:** user messages with Placeholders only; custom entries are not rendered (observed).
- **Compaction:** Placeholders only, as in (d) (observed).
- **Modes:** JSON and RPC show the Placeholder user message, plus the snapshot as an `entry_appended` record (source-only for the record).

## Comparison matrix

"Exp" means the full Expansion; "PH" means the Placeholder text.

| Behaviour | (a) input + Markdown | (b) hidden side-car | (bc) visible side-car | (c) custom instead of user | (d) context | (de) context + snapshot |
|---|---|---|---|---|---|---|
| Model, prompt | Exp inline | PH, then Exp as a second user message | same as (b) | Exp inline | Exp inline | Exp inline |
| Model, steer and follow-up | Exp | PH only; workaround costs an extra request | same as (b) | Exp | Exp | Exp |
| Live transcript | PH | PH | PH plus summary card | PH | PH | card, then PH |
| Expand on demand | no | no | ctrl+o (global), click (one) | ctrl+o, click | no | ctrl+o, click |
| Steering queue line | first line of Exp | PH | PH | none shown | PH | PH |
| Up-arrow, live | PH | PH | PH | PH | PH | PH |
| Up-arrow, after resume | Exp | PH | PH | nothing | PH | PH |
| `/fork` selector and editor | Exp | PH (side-car dropped) | PH | not selectable | PH | PH (orphan card possible) |
| HTML export | Exp | PH plus hidden Exp | PH plus visible Exp | Exp | PH | PH |
| Compaction input | Exp | PH plus Exp | PH plus Exp | Exp | PH | PH |
| Resume, model | stored Exp | stored side-car | stored side-car | stored Exp | needs extension and mapping | needs extension; snapshot stored |
| Resume, transcript | PH if extension loaded | PH | cards | renderer if loaded | PH | cards |
| Prompt cache | stable | stable | stable | stable | stable only if Exp byte-identical | stable |
| Print mode | works | works | works | prompt lost | works | works |
| JSON events | Exp | PH plus custom with `display: false` | PH plus custom with `display: true` | nothing (prompt lost) | PH | PH plus `entry_appended` |
| RPC events | Exp | as JSON | as JSON | custom message; `prompt` answers `handled` | PH | PH plus `entry_appended` |
| Session file | Exp in user message | PH plus `custom_message` | PH plus `custom_message` | `custom_message` only | PH | PH plus `custom` entry |

## Open risks

- **Real prompt caching was not measured.** The stub reports zero usage. "Stable" means the messages the provider received began with the previous request's messages byte for byte, and it assumes the provider serializes them deterministically.
- **Placeholders are numbered per message.** `[Context Ref #1]` appears in many messages. Routes (b), (d) and (de) need a durable map from a Placeholder in a given message to a Ref and to the content that was sent. Matching by exact message text, as the (de) probe did, breaks when two messages have the same text. Routes (a) and (c) store the content, so they need no map.
- **Collapsing in (a) depends on recognising delimiters in arbitrary content.** A file that contains the closing delimiter would break the collapse. The transformer also runs on assistant Markdown, so an assistant reply that quotes a delimited block is collapsed too. Each extension gets one transformer; a second `registerMarkdownTransformer` call replaces the first (`pi-coding-agent/dist/core/extensions/loader.js:285`).
- **ctrl+o is global.** It expands every tool output at the same time. Per-message expansion needs the mouse and fullscreen mode; regular mode has no keyboard path for it yet.
- **Steer and follow-up in (b) and (bc).** The side-car workaround depends on the user's queue mode. In the default mode it adds a model request in which the model answers the Expansion on its own.
- **Route (c) breaks the "expands in every mode" premise.** It loses the prompt in print and JSON modes, unless the extension falls back to another route outside the TUI and RPC.
- **The compaction summary for (d) and (de) never sees the Expansion.** A `session_before_compact` handler could supply its own summary input. That was not tested.
- **Other extensions see different text per route.** With (a), later `input` handlers and `before_agent_start` see the Expansion. With (b), (d) and (de) they see the Placeholder. With (c) they see no user prompt. This matters for the pi-switchboard classifier and pi-account-guard, which the map lists under "Not yet specified".
- **Not tested:** images in the prompt, prompt templates and skills combined with a Placeholder, `/tree` and `/clone`, the `/resume` selector (it renders through the same `renderInitialMessages` path as `-c`, `interactive-mode.js:3381`), very large Expansions (up-arrow history keeps up to 100 entries), and option+up in the TUI (source-only above).
