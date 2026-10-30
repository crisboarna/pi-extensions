# @crisboarna/pi-context-refs

Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent.

**Status: design only.** The approved design is in [DESIGN.md](DESIGN.md); the extension is not built yet and this package is not published.

## Install

Not published yet. Once released:

```bash
pi install npm:@crisboarna/pi-context-refs
```

## Quick start

The design says: press `#` in pi's editor, pick a ref, send. See [DESIGN.md](DESIGN.md) section 7 and section 8.

## What you get

The design promises:

- Named refs for a path, a file, a snippet of text, or the output of a command or URL.
- A `#` picker with saved and recent refs, and an `alt+r` overlay with a preview.
- A short `[ref:name]` placeholder in your draft that one Backspace deletes.
- Real content in the message the model gets, read when you send.
- Refs of your own and refs shared with your team, with project commands run only after you approve them.
- Typed `#name` refs that expand in print, JSON and RPC modes too.

## Limitations

- Not built and not verified in a live pi session.
- The known limits of the design are in [DESIGN.md](DESIGN.md) section 17.

## License

[MIT](LICENSE)
