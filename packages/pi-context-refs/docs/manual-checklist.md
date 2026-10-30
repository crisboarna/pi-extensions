# Manual checklist

These checks need a person at a real terminal. Nobody has run them yet, so no box is ticked. Tick a box only after you ran the step in a real TUI, and write the date, the pi version and what you saw under "Results". The list comes from [DESIGN.md](../DESIGN.md) section 16.2.

Setup: start pi with `PI_CODING_AGENT_DIR` pointing at a temporary directory and `pi -ne -e ./packages/pi-context-refs/src/index.ts` in a scratch git repository that has a `README.md`, a `src/api.ts` and an uncommitted change. Save a few refs: `/ref add api file src/api.ts desc="The public API"`, `/ref add rules snippet "Answer in one paragraph."` and `/ref add tests dynamic npm test`.

## Looks

- [ ] The inline list after `#` at 120, 80 and 40 columns: nothing wraps into the next row, the layer mark, name, kind and description stay readable, and the selection is visible.
- [ ] The `alt+r` overlay at the same widths: the filter, the sections, the key hints and the preview fit, and a long preview scrolls or cuts without breaking the frame.
- [ ] Both at least in the dark and the light theme, and with a ref whose description holds wide characters (CJK, emoji).
- [ ] The collapsed lines `▸ ref name (kind, size)` in the transcript after a send, in both themes.

## Sessions

- [ ] Send a message with a File ref, then fork from it (`/fork`): the fork selector and the editor show the full text, and sending it again does not add a second block.
- [ ] Resume the session (`pi -c`): up-arrow recalls the full text, and the transcript shows the collapsed lines.
- [ ] Export (`/export`): the HTML holds the full text.
- [ ] Compact (`/compact`): the summary is made from the full text and the session keeps working.
- [ ] `ctrl+o` on a message with blocks: record what it shows. Pi gives user messages no expand state, so the expected result is that nothing changes; `/ref sent` is the way to read the full text.

## Keystrokes

- [ ] Backspace right after `[ref:api]` deletes the whole placeholder; Left and Right skip over it.
- [ ] Ctrl+W right after `[ref:api]` deletes only the placeholder and keeps the word before it.
- [ ] Ctrl+Z (undo) after a delete brings the placeholder back whole.
- [ ] Up-arrow recall of a sent message that held a placeholder.
- [ ] A pick from `alt+r` after a typed `#ap` replaces the `#ap`, with no stray character.
- [ ] Esc during a slow command ref (`/ref add slow dynamic sleep 5`) cancels the send and restores the draft.

## Approval

- [ ] In a trusted scratch project, `/ref add gitlog dynamic git log --oneline -3 in=project` asks one question, and the wording of the definition is clear: it names the ref, the command or URL and the directory.
- [ ] Sending `#gitlog` after a change of the command asks again, and its three choices (run once, always for this definition, deny) are clear.
- [ ] Judge the wording of the Approval prompt itself, and write down any change you want.

## Coexistence

Install each extension beside this one, restart pi, and check that `#` opens the list, a pick inserts a placeholder, Backspace deletes it whole, and a send reaches the model with the block.

- [ ] pi-image-view (an image paste and a File ref in one message).
- [ ] pi-up-history (up-arrow recall).
- [ ] pi-cc-steer (a steer message that holds a ref).
- [ ] pi-multi-pass (a ref in a message sent after a rotation).
- [ ] pi-powerline-footer (the "running #x…" status and the footer).

## Results

No run recorded yet.

## Release decision

Releasing needs the maintainer's approval. This package is at `0.0.0` and the changesets already in `.changeset/` for it are empty. Before the first release the maintainer decides the bump and writes one non-empty changeset for `@crisboarna/pi-context-refs`, for example:

```text
---
"@crisboarna/pi-context-refs": minor
---

First release: save Path, File, Snippet and Dynamic refs, pick them with `#` or `alt+r`, and send their content as context blocks.
```
