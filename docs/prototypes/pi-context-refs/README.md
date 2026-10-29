# Prototype: the picker and the Placeholder in pi's editor

Throwaway code, never merged. It answers [How do the picker and the Placeholder look and behave in the editor?](https://github.com/crisboarna/pi-extensions/issues/168) on the map [Map: design spec for pi-context-refs](https://github.com/crisboarna/pi-extensions/issues/162).

`editor-prototype.ts` is a pi extension. Its Ref library is fake and in memory, File refs read a few files of this repository, and the Dynamic ref never runs anything. A stub model, `ctxref-proto/echo`, replies with exactly the user message it received, so you can see each Expansion without any network.

## Run it

From the repository root, in an empty agent directory with no other extensions:

```sh
PI_CODING_AGENT_DIR=$(mktemp -d) node_modules/.bin/pi -ne \
  -e .claude/worktrees/prototype-editor/docs/prototypes/pi-context-refs/editor-prototype.ts \
  --model ctxref-proto/echo
```

Pi asks whether to trust the folder; "Trust (this session only)" saves nothing.

To see it next to your own extensions (four of them replace the editor), drop `PI_CODING_AGENT_DIR=…` and `-ne`. Pi may then remember `ctxref-proto/echo` as your last model; switch back with `/model`.

## Switch variants

The line above the editor shows the current variant. `/proto` switches it:

| Command | Values | What changes |
|---|---|---|
| `/proto route` | `atomic`, `chip`, `token` | How the Placeholder is made (below) |
| `/proto label` | `1`, `2`, `3` | `[Context Ref N]`, `[ref:name]`, `[Context Ref N: name]` |
| `/proto picker` | `inline`, `overlay` | pi's autocomplete list, or a sectioned overlay with a preview |
| `/proto shadowed` | | Lists the Refs hidden by a Visible Ref with the same name |

`alt+r` opens the overlay picker at any time, without typing `#`.

The three routes:

- **A, atomic** (`atomic`): the Placeholder is plain text, made atomic by overriding the editor's private `segment` method. The label is ours, and the Expansion is read when you send.
- **B, chip** (`chip`): the Placeholder is one of pi's own `[paste #N]` markers, with our label drawn over it on screen. pi makes it atomic everywhere, but the content is taken when you pick it, and the buffer, history and external editor show `[paste #N …]`.
- **C, token** (`token`): the picker inserts the typed form, `#name`, with nothing private. It isn't atomic, and it is exactly what you would type in print mode.

## Try

- Type `#`, then a few letters, then Tab or Enter. Try `#tag:review` for a Bundle.
- Backspace into a Placeholder, move the cursor across it, press Ctrl+W after it, undo with Ctrl+-.
- Put two or three Placeholders in one message, send it, and read what the stub model received.
- Press Up after sending: what comes back in the editor?
- Type `#123` or `# heading`: the picker should stay out of the way.
- Compare the inline list with the overlay (`/proto picker overlay`): sections, kind marks and the preview.

Report back which route, label and picker you want, and anything that felt wrong.
