# Footer

With [pi-powerline-footer](https://www.npmjs.com/package/pi-powerline-footer), add to `powerline.customItems` in `~/.pi/agent/settings.json`:

```json
{ "id": "tier", "statusKey": "tier", "position": "right", "prefix": "⇄", "hideWhenMissing": true },
{ "id": "tier-sub", "statusKey": "tier-sub", "position": "right", "hideWhenMissing": true }
```

It shows, for example, `work · deep · big-model · 0.92`, and marks pins, dry-run, fallbacks and borrowed tiers. While subagents run, `tier-sub` counts them.

Change the text with `ui.status` and `ui.statusSub`. Placeholders: `{profile} {tier} {rank} {member} {model} {provider} {account} {thinking} {strategy} {confidence} {reason} {kind} {switches}`. Empty placeholders disappear with their separator.

`/tier doctor` says whether the footer item is configured.
