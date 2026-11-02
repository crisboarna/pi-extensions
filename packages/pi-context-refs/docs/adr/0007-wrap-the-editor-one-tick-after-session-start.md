---
status: accepted
---

# The editor is wrapped one tick after `session_start`

The package wraps whichever editor is in the slot, so that a Placeholder is one unit under Backspace. It now does that one tick (`setTimeout(0)`) after `session_start`, when every extension's `session_start` has run, instead of inside its own handler.

Wrapping inside the handler wraps the editor that was installed by the extensions loaded before this one, and an extension loaded after it replaces the package's editor. Which extension wins then depends on the load order, which the person does not control. Waiting a tick makes the editor that is wrapped the last one installed, whatever the order. pi-cc-steer already does this to wrap whatever it finds.

## Measured before the decision

Against real extensions installed by `npm run coexist` (pi-cc-steer 0.1.10, pi-image-view 0.5.0, pi-powerline-footer 0.21.0), loaded after the package, one Backspace on a typed Placeholder:

| Extension | Wrapping in the handler | Wrapping one tick later |
|---|---|---|
| pi-cc-steer | one unit | one unit |
| pi-image-view | one character, the send still expands it | one unit |
| pi-powerline-footer | one character, the send still expands it | one unit |

Loaded before the package, all three were already one unit. The gap between `session_start` and the wrap was 0.5 to 2 ms over eight starts, and 28 ms for the first, cold one.

## Considered options

- **Keep wrapping in the handler.** Rejected: it costs nothing, but leaves two of three real extensions with plain-text Placeholders when they load after the package, which a person cannot change.
- **A setting that turns the deferral on.** Rejected: a second code path, to test in both modes, and a README entry, for a behaviour that every user wants.
- **Wrap on the first keystroke or the first render.** Rejected: both move the swap into the moment the person is typing or drawing, where a tick after the session starts does not.

## Consequences

- Until the tick, the slot holds what the other extensions put there. The overlay cannot read the draft in that window, which is shorter than a person can type.
- The timer is cleared when the session shuts down, so a session that ends before the tick is never touched, and a second `session_start` before the tick wraps once.
- The package now patches `segment` on editor instances it did not create in either order. An editor without `segment` is left alone, as before, and the three real editors behaved in the order where this already happened.
- An extension that replaces the editor later than the tick, without wrapping ours, still removes the decoration. `test/tui/neighbours-keys.test.ts` pins that with an extension that swaps the editor after 100 ms; Placeholders then are plain text that still expands on send.
- Tests that start a session against the fake host wait one tick before they look at the editor slot.
