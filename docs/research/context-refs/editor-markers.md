# How existing pi packages draw atomic markers and chips in the editor

Research for [#163](https://github.com/crisboarna/pi-extensions/issues/163) on the map [#162](https://github.com/crisboarna/pi-extensions/issues/162). It feeds the Placeholder route that the prototype ticket [#168](https://github.com/crisboarna/pi-extensions/issues/168) decides.

Sources: pi 1.4.0 as installed in this repository (paths below are relative to `node_modules/@earendil-works/`), and the published tarballs of [`pi-image-view` 0.5.0](https://unpkg.com/pi-image-view@0.5.0/), [`@xynogen/pix-display` 0.3.2](https://unpkg.com/@xynogen/pix-display@0.3.2/) with its chip code in [`@xynogen/pix-pretty` 1.32.0](https://unpkg.com/@xynogen/pix-pretty@1.32.0/), and [`pi-insert` 0.4.2](https://unpkg.com/pi-insert@0.4.2/). The package code was read, never run. The probes were our own code against pi's installed `pi-tui` and the repository's pinned `pi`.

## Answer

pi 1.4.0 has no public API for an atomic inline token. Its Editor makes exactly one kind of text atomic: `[paste #N]`, `[paste #N +L lines]` or `[paste #N C chars]`, and only while `N` is a key in the Editor's TS-private `pastes` map. The three packages reach that atomicity in three different ways:

- **`pi-image-view`** keeps its own registry keyed by the marker text `[Image #N]`. It makes the marker atomic by replacing the Editor's TS-private `segment` method on the instance and by intercepting left, right, Backspace and Delete in `handleInput`. It expands the marker in the `input` event. The label is free, and the marker survives editor swaps because it is matched as text. But the replacement `segment` drops pi's own paste-marker merging, so on the same editor pi's `[paste #N]` markers stop being atomic and can be broken into dead text.
- **`@xynogen/pix-display`** writes into pi's private `pastes` registry, keeps pi's `[paste #N C chars]` label in the buffer and swaps in its own label only in `render` output. Atomicity, undo and wrapping are pi's own. It uses seven TS-private members with no feature checks. Its registry entries are lost whenever pi copies the editor text: on an editor swap, when a non-overlay `ctx.ui.custom()` closes, or on `setEditorText`.
- **`pi-insert`** uses only the public `ctx.ui.pasteToEditor`. That gives pi's native marker with pi's fixed label, and only above 10 lines or 1000 characters. It cannot carry a custom label, and it has the same registry loss as pix-display.

None of the three checks pi's version: they declare `*` peers or no peers at all. Only pi-image-view feature-checks the private members it uses. The two packages that take the editor slot wrap whatever `getEditorComponent()` returns. A later extension that calls `setEditorComponent` without wrapping, as all three of pi's editor examples do, replaces them. None registers an autocomplete provider. But a `#` inside a text Placeholder such as `[Context Ref #1]` puts the editor into a `#` autocomplete context, as soon as the user types or deletes right after it.

## Evidence

### What pi-tui's Editor treats as atomic

- The only atomic pattern is hard-coded: `PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g` (`pi-tui/dist/components/editor.js:12`, single form at `:14`). `segmentWithMarkers` merges a match into one segment only when its id is in `validIds` (`editor.js:26-41`). `validIds` is `new Set(this.pastes.keys())`, and the Editor's `segment` method passes it (`editor.js:272-278`).
- Everything that moves or deletes by grapheme calls `this.segment`: cursor left and right (`editor.js:1594-1620`), Backspace (`editor.js:1162`), Delete (`editor.js:1489`), mouse hit-testing (`editor.js:527`), the fake cursor (`editor.js:447`) and word wrap (`editor.js:848`, `:1544`). Word wrap keeps an atomic segment whole and splits it only when it is wider than the line (`editor.js:125-138`). Word movement and Ctrl+W treat only `isPasteMarker` segments as atomic (`editor.js:1666-1669`, `:1830`). Any other multi-character segment that contains a space counts as whitespace there, because `isWhitespaceChar` is `/\s/.test` (`pi-tui/dist/utils.js:919-921`).
- Backspace on a paste marker deletes the registry entry, then renumbers every higher id and every higher marker in the text (`editor.js:1163-1185`).
- Undo snapshots are `structuredClone`s of `{ state, pastes, pasteCounter }` (`editor.js:1772-1789`, `pi-tui/dist/undo-stack.js:10-12`). Undo therefore restores the registry too, as long as its values are cloneable.
- Pasting goes through `handlePaste`. It stores a paste and inserts a marker only above 10 lines or 1000 characters (`editor.js:1088-1098`). `ctx.ui.pasteToEditor(text)` sends a synthetic bracketed paste to the active editor's `handleInput` (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:2073`, documented as "collapse for large content" in `pi-coding-agent/dist/core/extensions/types.d.ts:132-133`).
- On Enter, `submitValue` expands the markers with `expandPasteMarkers`, clears the registry and passes the expanded text to `onSubmit` (`editor.js:1138-1152`, `:900-908`). The `input` event therefore never sees a paste marker. `ctx.ui.getEditorText()` also returns the expanded text (`interactive-mode.js:2075`).
- `setText` clears `pastes` and `pasteCounter` (`editor.js:921-933`).
- An autocomplete completion replaces `state.lines` with whatever `applyCompletion` returns (`editor.js:612-622`, `:627-645`). It goes through neither `insertTextAtCursor` nor the registry.
- The `EditorComponent` contract has no token or marker API (`pi-tui/dist/editor-component.d.ts:10-38`). `state`, `pastes`, `pasteCounter`, `segment`, `handlePaste`, `insertTextAtCursorInternal`, `expandPasteMarkers`, `submitValue`, `setCursorCol`, `pushUndoSnapshot` and `undo` are all declared `private` (`pi-tui/dist/components/editor.d.ts:34-220`).

### pi-image-view 0.5.0: own registry, `segment` override

Reaches:

- **The editor slot, by composition.** `PiEditorAdapter.install` reads `ctx.ui.getEditorComponent()`, builds that factory's editor and decorates it, or builds its own `CustomEditor` subclass ([`pi-adapter.ts:17-42`](https://unpkg.com/pi-image-view@0.5.0/src/pi-adapter.ts), [`atomic-editor.ts:189-211`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts)). On shutdown it restores the displaced factory, but only while it still owns the slot ([`pi-adapter.ts:49-71`](https://unpkg.com/pi-image-view@0.5.0/src/pi-adapter.ts)). It carries pi-zentui's ownership symbols across ([`pi-adapter.ts:35-40`](https://unpkg.com/pi-image-view@0.5.0/src/pi-adapter.ts)). It installs only in TUI mode ([`extension-runtime.ts:421-438`](https://unpkg.com/pi-image-view@0.5.0/src/extension-runtime.ts)).
- **TS-private members on the instance.** It writes `segment`, `lastAction` and `historyIndex`, and calls `pushUndoSnapshot` and `setCursorCol`. It reads and writes `state` ([`atomic-editor.ts:9-16`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts), `:95-96`, `:149-165`). It also redefines `onSubmit` and `onPasteImage` as accessors. That relies on pi assigning `onPasteImage` only while it is unset ([`atomic-editor.ts:104-147`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts); pi's side is `interactive-mode.js:2245-2247`). It also wraps `render` to add OSC 8 links ([`atomic-editor.ts:57-72`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts)).
- **Public events.** `input` for the Expansion, `context` to strip link targets from model messages, `registerMarkdownTransformer` for transcript links, `onTerminalInput` and a 250 ms poll of `getEditorText`/`setEditorText` to turn pasted image paths into markers ([`extension-runtime.ts:139-191`](https://unpkg.com/pi-image-view@0.5.0/src/extension-runtime.ts), `:280-382`, `:466-563`).

What makes `[Image #N]` atomic:

- **Cursor, wrap, mouse and the fake cursor.** The instance `segment` returns `segmentAtomicImageMarkers(text, …)`, which merges every `[Image #\d+]` match on top of a plain `Intl.Segmenter` ([`atomic-editor.ts:95-96`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts), [`marker-spans.ts:3`](https://unpkg.com/pi-image-view@0.5.0/src/marker-spans.ts), `:28-46`). Every pi path listed above then sees one segment. Matching is by text, so no registry entry is needed.
- **Backspace, Delete and left and right.** The `handleInput` intercept finds the marker span at the cursor. It moves the cursor to the span's edge, or deletes the span after `pushUndoSnapshot` ([`atomic-editor.ts:149-184`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts), [`marker-spans.ts:13-26`](https://unpkg.com/pi-image-view@0.5.0/src/marker-spans.ts)). Without `pushUndoSnapshot` it falls back to pi's normal deletion (`atomic-editor.ts:154`, `:183`).
- **Undo.** pi's own snapshot of `state` restores the text. The image lives in the extension's draft store, and the 250 ms poll drops an image once its marker is gone from the text ([`extension-runtime.ts:299-307`](https://unpkg.com/pi-image-view@0.5.0/src/extension-runtime.ts); the README says "Removing the marker detaches the image", [`README.md:63`](https://unpkg.com/pi-image-view@0.5.0/README.md)). An undo after that poll brings back the text without its image. This was read from the code, not run.
- **Ctrl+W.** Because `[Image #1]` contains a space and is not a paste marker, word deletion treats it as whitespace. It deletes the marker together with the word before it (probe T4 below, with the same technique on `[Context Ref #1]`).

Expansion on submit: the marker passes through `submitValue` untouched, because it is not in `pastes`. The `input` handler then swaps each draft marker for `[[Image #N]](file://…)` in the stored text and adds the prepared image blocks ([`extension-runtime.ts:478-562`](https://unpkg.com/pi-image-view@0.5.0/src/extension-runtime.ts)). It skips `/` commands and `!` shell lines (`:470-476`). The `context` event strips the link targets before the model sees them ([`attachment-links.ts:70-101`](https://unpkg.com/pi-image-view@0.5.0/src/attachment-links.ts)). Numbers continue across the session branch ([`extension-runtime.ts:121-130`](https://unpkg.com/pi-image-view@0.5.0/src/extension-runtime.ts), [`draft-store.ts:13-18`](https://unpkg.com/pi-image-view@0.5.0/src/draft-store.ts)).

Fragility across pi versions:

- It has no version check. Its peers are `*` ([`package.json:58-61`](https://unpkg.com/pi-image-view@0.5.0/package.json)). The changelog says private seams are "feature-checked at runtime instead of using peer semver as an ineffective compatibility gate" ([`CHANGELOG.md:82`](https://unpkg.com/pi-image-view@0.5.0/CHANGELOG.md)). It was tested on pi 0.84.3 and then 1.1.0 (`CHANGELOG.md:15`, `:146`).
- Feature checks: it requires `handleInput`, `getCursor`, `getLines` and `getText`, and an own `state` with a `lines` array. Otherwise it declines and logs ([`atomic-editor.ts:74-92`](https://unpkg.com/pi-image-view@0.5.0/src/atomic-editor.ts)). `setCursorCol` is optional.
- If pi renamed `segment`, the assignment would still succeed but nothing would call it. Wrap and cursor atomicity would silently go, and only the `handleInput` intercept would remain. If pi renamed `state`, the decorator would decline. Either way it degrades to plain text, and the Expansion in `input` still works.

Coexistence:

- **Editor replacements.** It decorates an earlier replacement, and a later replacement that does not wrap removes it. The probes below show both orders in real pi.
- **pi's own paste markers on the same editor.** The replacement `segment` does not call pi's marker-aware one. Probe T4 shows the result with the same technique: Backspace after a pi paste marker deletes only its `]`. The text no longer matches `PASTE_MARKER_REGEX`, so the paste is not expanded on submit. This hits pi-insert's markers and pix-display's chips whenever both packages decorate one editor. This was inferred from the technique; the two packages were not run together.
- **Collapsed pastes.** Its path scanner rewrites the draft with `setEditorText(expandedText)` ([`extension-runtime.ts:283`](https://unpkg.com/pi-image-view@0.5.0/src/extension-runtime.ts), `:336-340`). When a draft has both an image path and a collapsed paste, the paste is inlined in full and its marker is lost.
- **Autocomplete providers.** It registers none. Its `#` label triggers `#` providers (probe T8).

### @xynogen/pix-display 0.3.2: pi's registry, display-only label

pix-display only calls `registerChips(pi)` ([`index.ts:19-23`](https://unpkg.com/@xynogen/pix-display@0.3.2/src/index.ts)). It depends on `@xynogen/pix-pretty` `^1.32.0`; the two versions were published the same minute on 2026-10-22. `chips.ts` is byte-identical in 1.32.0 and the current 1.34.0 (checked with `diff`).

Reaches:

- **The editor slot, by composition.** At `session_start` in TUI mode it wraps `getEditorComponent()`. It decorates the editor only if it is `instanceof CustomEditor` ([`chips.ts:296-305`](https://unpkg.com/@xynogen/pix-pretty@1.32.0/src/chips.ts)). On shutdown it clears the slot unconditionally (`:307-309`).
- **TS-private members, with no feature checks.** It casts the editor to `pastes`, `pasteCounter`, `state`, `setCursorCol`, `expandPasteMarkers`, `handlePaste` and `insertTextAtCursorInternal` ([`chips.ts:42-50`](https://unpkg.com/@xynogen/pix-pretty@1.32.0/src/chips.ts), `:195-282`). The authors' own note: "Pi only exposes atomic paste tokens today. Keep its private registry adapter here; replace this adapter when Pi provides a public inline-token API" (`:35-36`).
- **pi's render output.** It rewrites marker spans inside the rendered lines. It has to know pi's cursor encoding: inverse video before pi-tui 1.4, the `\x1b_pi:fc\x07` APC pair in 1.4 (`:54-57`, `:81-88`, `:140-151`).
- **`registerMarkdownTransformer`** for chips in sent messages (`:286-294`).

What makes a chip atomic: the buffer holds a real pi marker `[paste #N C chars]` with a registry value. The value is a string for text, or an object such as `{ kind: "path", path }` ([`chips.ts:37-41`](https://unpkg.com/@xynogen/pix-pretty@1.32.0/src/chips.ts), `:243-273`). pi's own `segment` makes it atomic for the cursor, Backspace with renumbering, undo, wrap and Ctrl+W. `render` then draws a label such as `@a.ts` or `text 42 chars` in its place (`:140-151`, `:274-281`). The screen label has a different width from the buffer label, so pi lays out the buffer label. A wider chip is clamped with `truncateToWidth` (`:279-280`). Producers insert tags such as `<path>…</path>` through `insertTextAtCursor`. pix-search, for example, intercepts `@` and opens an overlay picker ([`pix-search 0.3.7 editor.ts:19-52`](https://unpkg.com/@xynogen/pix-search@0.3.7/src/editor.ts)). The patched `insertTextAtCursor` turns those tags into registry markers and adds a trailing space ([`chips.ts:243-273`](https://unpkg.com/@xynogen/pix-pretty@1.32.0/src/chips.ts)).

Expansion on submit: pi's `submitValue` calls the instance's replacement `expandPasteMarkers`. That emits the tags verbatim and wraps text pastes in `<paste>…</paste>` ([`chips.ts:70-79`](https://unpkg.com/@xynogen/pix-pretty@1.32.0/src/chips.ts), `:198`). The stored message and the model get the full tags. The transcript collapses them back to chips through the Markdown transformer (`:173-192`).

Fragility across pi versions:

- It has no version check: `*` peers ([`package.json:44-47`](https://unpkg.com/@xynogen/pix-display@0.3.2/package.json)) and no `typeof` guards. `pi.handlePaste.bind(editor)` throws inside the editor factory if pi renames `handlePaste` ([`chips.ts:199`](https://unpkg.com/@xynogen/pix-pretty@1.32.0/src/chips.ts)). At that point pi has already set the factory and cleared the editor container (`interactive-mode.js:2207-2214`). What the user sees then was not tested.
- It depends on pi's exact label format (`chips.ts:53`), on pi's 10-line/1000-character rule, which it corrects after the fact (`:205-241`), and on pi's render escape codes. The 1.4 fake-cursor change already needed a fix (`:54-56`, `:84`).

Coexistence:

- **Editor replacements.** The same as pi-image-view, and `instanceof CustomEditor` holds across extensions in pi 1.4.0 (probe A). A non-`CustomEditor` editor is kept without chips (`chips.ts:301-302`).
- **Every paste, not only its own.** It changes the paste threshold to 100 characters for all pastes (`chips.ts:51-52`, `:221`) and wraps every collapsed text paste in `<paste>…</paste>` on submit (`:74`). A pi-insert payload over 100 characters is therefore sent as `<paste><file …>…</file></paste>`.
- **Autocomplete providers.** It registers none. Completions bypass `insertTextAtCursor` (`editor.js:612-645`), so a tag inserted by `applyCompletion` stays raw text and gets no chip.

### pi-insert 0.4.2: public `pasteToEditor` only

Reaches only public API: `ctx.ui.editor`, `ctx.ui.select`, `ctx.ui.setStatus`, `ctx.ui.notify` and `ctx.ui.pasteToEditor(prompt)`, followed by `pasteToEditor("\n")` in TUI mode ([`extensions/index.ts:141-221`](https://unpkg.com/pi-insert@0.4.2/extensions/index.ts)). The pasted text is `<file name=… bytes=…>…</file>` blocks (`:134-138`).

What makes it atomic: nothing of its own. pi collapses the paste into `[paste #N +L lines]` or `[paste #N C chars]` only above 10 lines or 1000 characters (`editor.js:1088-1098`). The README says it "may appear as a compact `[paste #…]` marker" ([`README.md:64`](https://unpkg.com/pi-insert@0.4.2/README.md)). The label cannot be chosen. Below the threshold the text is inserted inline.

Expansion on submit: pi's `submitValue` puts the full `<file>` text into the message. The transcript shows it in full.

Fragility across pi versions: the lowest of the three. It declares no peer dependency, only a dev dependency `@earendil-works/pi-coding-agent ^0.84.4` for types ([`package.json:34-36`](https://unpkg.com/pi-insert@0.4.2/package.json)). It relies on documented behaviour only. In RPC mode `pasteToEditor` becomes `setEditorText` with no collapse (`pi-coding-agent/docs/rpc-extension-ui.md:21`).

Coexistence: it does not touch the editor slot, so any editor that forwards bracketed paste to pi-tui's `handlePaste` works. Its markers carry the shared risks: registry loss on a swap, a non-overlay `custom()` or `setEditorText` (probes), and loss of atomicity under pi-image-view's `segment` override (probe T4).

### The editor slot, dialogs and autocomplete in pi 1.4.0

- **One slot, last call wins.** `setCustomEditorComponent(factory)` stores the factory, copies `this.editor.getText()` (the raw text with markers) and calls the new editor's `setText` (`interactive-mode.js:2206-2219`). `setText` clears the new editor's registry, so every pi paste marker becomes dead text. pi then wires `onSubmit` and `onChange`, the autocomplete provider and, by duck typing, the app handlers (`:2216-2253`). `resetExtensionUI` clears all autocomplete wrappers and the custom editor (`:1898-1915`).
- **The three editor examples never compose.** `modal-editor.ts:83`, `rainbow-editor.ts:86` and `border-status-editor.ts:148` call `setEditorComponent` with a fresh `CustomEditor` subclass and never read `getEditorComponent()`. pi's docs say only "Extend Pi's `CustomEditor` when replacing the main editor" (`pi-coding-agent/docs/tui.md:52-54`).
- **Dialogs.** A non-overlay `ctx.ui.custom()` saves `getText()` and restores it with `setText` when it closes (`interactive-mode.js:2289-2299`). That clears the registry. Overlays skip the restore. `select`, `confirm`, `input` and `editor` push a dialog onto the editor slot without touching the editor's text (`:2110-2200`).
- **Autocomplete.** `addAutocompleteProvider` wrappers chain, and the merged provider is handed to whichever editor is active (`interactive-mode.js:545-560`, `:2231-2233`). An editor replacement does not break providers, and providers do not see markers specially.
- **RPC.** `setEditorComponent` and `addAutocompleteProvider` are no-ops, `getEditorComponent()` returns `undefined`, and `pasteToEditor()` delegates to `setEditorText()` (`pi-coding-agent/docs/rpc-extension-ui.md:18-21`).

### Probes

Two probes ran, both with our own code in a scratch directory, outside the repository.

**Probe 1** used pi-tui 1.4.0's `Editor` directly in Node (`new Editor(tui, theme)` with a stub `tui`):

| Case | Result |
| --- | --- |
| T1: 12-line bracketed paste typed between `a` and `b`, with a space on each side | `a [paste #1 +12 lines] b`. Left jumps from col 22 to col 2. Backspace on the marker gives `a b` and an empty registry. Undo restores the text and registry id 1. |
| T1b: two pastes, Backspace on the first | `" [paste #1 1200 chars]"`: the second paste is renumbered to 1. |
| T2: `see [Context Ref #1]` inserted, no override | Left moves one character. Backspace leaves `see [Context Ref #1` (not atomic). |
| T3: paste, then `setText(getText())`, as a swap or `custom()` close does | The text is unchanged but the registry is empty. The expanded text is the literal marker. Backspace leaves `[paste #1 +12 lines`. |
| T4: instance `segment` replaced by one that merges `[Context Ref #\d+]` over a plain `Intl.Segmenter` (pi-image-view's technique) | Left from the end lands at col 4. Backspace leaves `see` and its trailing space. Undo restores. Ctrl+W after the label gives an empty line (the label and `see`). A pi paste marker added after it: Backspace leaves `… [paste #1 +12 lines`, registry id 1 still present, the content no longer expandable. |
| T5: the same override, but it merges on top of `Editor.prototype.segment.call(this, …)` | The label and pi's paste marker are both atomic. Backspace removes the paste marker and its registry entry, then the label as a whole. |
| T6b: `xxxxxxxxxxxxxxxxxxxx[Context Ref #1] tail` rendered at width 30 | With the override, the label moves whole to line 2. Without it, it splits as `…[Context` / `Ref #1] tail`. |
| T7: a registry entry written by hand (`pastes.set(1, "EXPANDED-REF-1")`) and the text `look [paste #1 9 chars] now` | The marker is atomic. Enter submits `look EXPANDED-REF-1 now`. |
| T8: a provider with `triggerCharacters: ["#"]`, then typing `x` after each label and pressing Backspace | `[Context Ref #1]` and `[Image #1]`: the provider is asked with `see [Context Ref #1]x` and `see [Context Ref #1]`. `[paste #1 +12 lines]`: never asked. |

**Probe 2** ran real pi 1.4.0 in TUI mode under a pseudo-terminal, offline, with `PI_CODING_AGENT_DIR` and `HOME` in a fresh temporary directory, the stub provider from `packages/pi-account-guard/test/support/stub-provider.ts`, and two probe extensions:

- *plain*: like modal-editor, it sets a `CustomEditor` subclass and ignores the earlier factory.
- *wrapper*: like pix-display and pi-image-view, it wraps `getEditorComponent()`, inspects the built editor, then runs `pasteToEditor` of 12 lines followed by each action below and reads `getEditorText()`.

| Check | plain, then wrapper (A) | wrapper, then plain (B) |
| --- | --- | --- |
| Whose editor is active | wrapper's, built around plain's `ModalLikeEditor` | plain's; the wrapper's decoration is gone |
| `instanceof CustomEditor`, own `state`, `segment`, `pastes` is a `Map`, `pasteCounter`, `handlePaste`, `insertTextAtCursorInternal`, `expandPasteMarkers`, `pushUndoSnapshot` present | all true | all true (on the wrapper's first editor) |
| Short `pasteToEditor("[Context Ref #1]")` | inserted as plain text | inserted as plain text |
| After a 12-line `pasteToEditor` | content expandable | content expandable |
| After `setEditorComponent(getEditorComponent())` | literal marker, content lost | literal marker, content lost |
| After a non-overlay `custom()` closes | literal marker, content lost | literal marker, content lost |
| After an overlay `custom()` closes | content kept | content kept |
| After `select()` is dismissed | content kept | content kept |

## Comparison

| | pi-image-view 0.5.0 | pix-display 0.3.2 (pix-pretty chips) | pi-insert 0.4.2 |
| --- | --- | --- | --- |
| Text in the buffer | `[Image #N]` | `[paste #N C chars]` | `[paste #N +L lines]` or `[paste #N C chars]`, or inline text |
| Label on screen | `[Image #N]`, with an OSC 8 link | its own chip label (render rewrite) | pi's label |
| Custom label | yes | on screen only | no |
| Registry | the extension's, keyed by marker text | pi's private `pastes` | pi's private `pastes` |
| Source of atomicity | instance `segment` override plus a `handleInput` intercept | pi's own marker segmentation | pi's own marker segmentation |
| Cursor, Backspace, Delete | whole marker | whole marker; pi renumbers higher ids | whole marker; pi renumbers higher ids |
| Undo | pi's snapshot of `state` | pi's snapshot of `state` and the registry | pi's snapshot of `state` and the registry |
| Wrap | whole | whole (laid out at the buffer label's width) | whole |
| Ctrl+W | the marker and the word before it | one atomic segment | one atomic segment |
| Expansion | `input` event | pi's `submitValue`, through a replaced `expandPasteMarkers` | pi's `submitValue` |
| Transcript | compact link (Markdown transformer) | chips (Markdown transformer) | full text |
| Public pi APIs | `get`/`setEditorComponent`, `input`, `context`, `registerMarkdownTransformer`, `onTerminalInput`, `get`/`setEditorText` | `get`/`setEditorComponent`, `registerMarkdownTransformer` | `pasteToEditor`, `editor`, `select` |
| TS-private members | `state`, `segment`, `pushUndoSnapshot`, `setCursorCol`, `lastAction`, `historyIndex` | `pastes`, `pasteCounter`, `state`, `setCursorCol`, `expandPasteMarkers`, `handlePaste`, `insertTextAtCursorInternal`, plus render escape codes | none |
| Version guard | none (`*` peers); feature checks that degrade | none (`*` peers); no feature checks | none (no peers) |
| Survives a swap, a non-overlay `custom()`, `setEditorText` | yes (matched as text) | no (registry cleared) | no (registry cleared) |
| A later replacement that does not wrap | removes it | removes it | unaffected |
| Effect on other markers on the same editor | breaks pi paste-marker atomicity; inlines collapsed pastes when it rewrites a path | 100-character threshold and `<paste>` wrapping for every paste | none |
| `#` autocomplete context after the marker | yes | no | no |

## Viable routes for a `[Context Ref #N]` Placeholder

Listed without a choice; [#168](https://github.com/crisboarna/pi-extensions/issues/168) decides. Every route keeps a typed ref token that expands in the `input` event in every mode, as the map settled.

1. **Placeholder as text, made atomic by a `segment` override (pi-image-view's technique).** Insert `[Context Ref #N]` as plain text, keep the Refs in the extension's own registry keyed by that text, and expand it in the `input` event.
   - Atomicity: replace `segment` on the editor instance, or override it in a `CustomEditor` subclass when the slot is free. Merge Placeholders on top of `Editor.prototype.segment`, so pi's paste markers stay atomic (probe T5). That alone gives atomic cursor movement, Backspace, Delete, undo and wrap. A `handleInput` intercept is optional.
   - Label and numbering: free, and owned by the extension, so `#N` is stable.
   - Robustness: it survives swaps, `custom()` and `setEditorText`, because it is matched as text. It also works for text inserted by `applyCompletion`.
   - Costs: one TS-private method, `segment`, plus `state` and `pushUndoSnapshot` if it intercepts keys. It needs the editor slot, so a later replacement that does not wrap leaves a plain-text Placeholder that still expands on send. A label with spaces is word-deleted together with the word before it (T4). The `#` in the label puts the editor into a `#` autocomplete context (T8).
2. **pi's paste registry, with the label drawn only on screen (pix-display's technique).** Write a registry entry, insert `[paste #N C chars]` and rewrite `render` to show `[Context Ref #N]`.
   - Atomicity: pi's own, everywhere, Ctrl+W included.
   - Expansion: pi expands the marker in the editor before `input` runs, so the `input` event sees the Expansion, not the Placeholder (T7).
   - Costs: the buffer, `getText`, prompt history and the external editor all show `[paste #N …]`. `#N` is pi's paste id, shared with real pastes and renumbered on Backspace. The registry is lost on a swap, a non-overlay `custom()` and `setEditorText` (probes), and on reload (`interactive-mode.js:1898-1915`). It patches several TS-private members and pi's render escape codes.
3. **Public `pasteToEditor` (pi-insert's technique).** No private members. But the label is pi's fixed `[paste #N …]`, and nothing collapses below 10 lines or 1000 characters. On its own it cannot give a custom label. With route 2's render rewrite it inherits route 2's costs.
4. **Plain text Placeholder with no editor internals.** Insert `[Context Ref #N]` through `insertTextAtCursor` or `applyCompletion`, and expand it in `input`. It works with any editor, in every mode, and with nothing private. It is not atomic (T2). It is also what routes 1 and 2 fall back to when another extension owns the slot.

For a picker in front of any route: an overlay `custom()`, a `select()` or an autocomplete list keeps pi's registry. A non-overlay `custom()` clears it. Only routes 2 and 3 depend on that registry.

## Open risks and what was not verified

- The three packages' code was read, not run. The pi-image-view harm to paste markers (T4) and the pix-display behaviour behind a renamed member are inferred from their source and from probes of the same techniques.
- How a throwing editor factory leaves pi's UI (the pix-display failure mode) was not tested.
- The probes ran on pi 1.4.0 only. The TS-private names cited can change in any pi release without notice, because none is in pi's public `.d.ts` contract.
- The real-pi probe drove pi through `ctx.ui` calls from a timer, not through keystrokes. Keyboard-level atomicity was checked on pi-tui's `Editor` in Node (probe 1), not in the full TUI.
- Interaction with pi-zentui or other editor packages beyond pi's examples was not tested.
