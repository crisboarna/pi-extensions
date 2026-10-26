# Footer

pi's footer shows the tier as it is. So does [pi-powerline-footer](https://www.npmjs.com/package/pi-powerline-footer), in its extension statuses segment, on the `default`, `full` and `nerd` presets. The `minimal`, `compact` and `ascii` presets leave that segment out, and so can `powerline.layout` or `powerline.disabledSegments`.

To give the tier a place of its own on any preset, which also takes it out of the extension statuses, add to `powerline.customItems` in `~/.pi/agent/settings.json`:

```json
{ "id": "tier", "statusKey": "tier", "position": "right", "prefix": "⇄", "hideWhenMissing": true },
{ "id": "tier-sub", "statusKey": "tier-sub", "position": "right", "hideWhenMissing": true }
```

It shows, for example, `work · deep · big-model · 0.92`, and marks pins, dry-run, fallbacks and borrowed tiers. While subagents run, `tier-sub` counts them.

Change the text with `ui.status` and `ui.statusSub`. Placeholders: `{profile} {tier} {rank} {member} {model} {provider} {account} {thinking} {strategy} {confidence} {reason} {kind} {switches}`. Empty placeholders disappear with their separator.

`/tier doctor` warns when powerline's settings leave the tier out of the footer.
