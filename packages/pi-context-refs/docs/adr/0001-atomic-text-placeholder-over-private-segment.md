---
status: accepted
---

# The Placeholder is plain text made atomic through pi-tui's private `segment`

The Placeholder `[ref:<name>]` is ordinary text in the editor buffer. The package makes it behave as one unit (one Backspace deletes it, the cursor skips over it) by merging it into a single segment on top of pi-tui's own `Editor.prototype.segment`, on whatever editor `getEditorComponent()` returns. `segment` is a TypeScript-private member, so this is a dependency on something pi does not promise to keep. The package feature-checks it, and a contract test asserts its shape on every run. If it is missing, or another extension replaces the editor without wrapping it, the Placeholder stays plain text that still expands on send.

The Placeholder names its Ref, so it needs no registry: undo, history recall, paste and an editor swap all keep working.

## Considered options

- **Pi's paste-store marker (`[paste #N …]`, through `pasteToEditor`).** Public for insertion, but the label is fixed, it appears only above 10 lines or 1000 characters, and its content is lost on an editor swap, when a non-overlay `custom()` closes and on `setEditorText`. Four of the user's installed packages replace the editor. Rejected.
- **A plain `#name` token with no atomic behaviour.** Public APIs only, but a half-deleted token is a different token, and nothing marks the boundary. Rejected.
- **A `CustomEditor`.** It takes the single editor slot and collides with every other editor-replacing extension. Rejected.

## Consequences

- A pi upgrade can break the merge. CI turns red through the contract test; users fall back to the plain-text behaviour.
- The package never owns the editor, so it coexists with other editor extensions that wrap.
- Placeholders in drafts, history and pasted text keep meaning the same thing.
