# Troubleshooting

Run `/tier doctor` first: it checks the setup and names the fix for each problem.

| Symptom | Cause | Fix |
|---|---|---|
| Every decision says `fallback` with `classifier-error` | The classifier server is not running or not reachable | Start it (for LM Studio, load the decision model) and run `/tier doctor` |
| "Model is unloaded" from LM Studio mid-request | LM Studio's just-in-time loading keeps one model, so the classifier and the chat model evict each other | Turn off that option, or load both with `lms load` |
| LM Studio rejects the classifier model | An MLX build loads as a chat model | Use the GGUF build ([classifier setup](classifier-setup.md)) |
| A classifier is "skipped: remote" | Its server is not on this machine, so it would receive request text | Set `"allowRemote": true` on that classifier, or use a local one |
| Many fallbacks with a working classifier | The threshold is above what the classifier usually reaches | Lower `classifiers[].threshold`; check the histogram in `/tier report` |
| The footer shows nothing | A powerline preset without extension statuses and no `powerline.customItems` entry, or a physical model is selected | Add the [footer](footer.md) items; pick `switchboard/auto` in `/model` |
| `switchboard inactive: no profiles configured` | No config, or every profile is invalid | Run `/tier init`, then `/tier validate` |
| `Ctrl+Alt+W` does nothing (macOS) | The terminal does not send Option as Alt | Ghostty: `macos-option-as-alt`; or change `ui.navigator.shortcut` |
| `/tier` prints nothing with `pi -p` | Print mode does not show notifications | Use the interactive TUI, or the `pi-switchboard` CLI |
| Subagents run on their own models | Their agent pins a model, or they use an external runner | Expected: explicit choices are never overridden ([subagents](subagents.md)) |
