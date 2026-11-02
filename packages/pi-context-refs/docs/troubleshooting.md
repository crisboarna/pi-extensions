# Troubleshooting

Start with `/ref doctor`. It checks both libraries, the approvals file, git, the editor and the trigger, says what is wrong and what to do, and changes nothing. Then `/ref list` prints the settings, every ref by library, the refs another library hides, any warnings about a file, and the Approval state of each Project command.

| Symptom | Cause | Fix |
|---|---|---|
| `#` opens nothing | Another extension replaced the editor or owns the key, or a space follows the `#` | Set `trigger` to another character and run `/reload`. `alt+r` always works |
| `/ref list` warns about the trigger | `trigger` is not one character, or is `/`, `@`, `!` or a space | Pick another character. The list uses `#` until you do |
| The project library is missing | Pi does not trust the project | Run `/trust`, then restart pi: a saved decision applies from the next start |
| A ref from the project library is skipped | Its path points outside the project, after following symlinks | Keep the paths of a shared library inside the project. The warning names the ref |
| A project command shows `(pending)` | You have not approved its definition, or it changed since you did | Send a message that names it from the TUI and answer the question, or run `/ref approve <name>` |
| A placeholder is sent as typed | No visible ref has that name now | Run `/ref list`: the ref may be removed, out of scope, or in a library that is not loaded |
| My ref is not the one that ran | A ref of the same name in a library that wins is hiding it | `/ref list` names the hidden refs. See [Which ref wins](configuration.md#which-ref-wins) |
| The send was cancelled and the draft came back | A file or a command could not be read, timed out, or was not approved | Read the reason shown, fix the ref and send again |
| A block says `error=…` in `pi -p` | The same failure, in a mode with no draft to restore | The reason is in the block and on stderr |
| `/ref` prints nothing in `pi -p` | Pi shows no extension notices there | The output is on stderr |
| `/ref approve` refuses | There is no UI to confirm in | Run it in the TUI; a script cannot approve a repository's refs |
| Backspace deletes one character of a placeholder | Another extension replaced the editor after the package wrapped it, or a pi upgrade changed a private method | The text still expands. See [With other extensions](with-other-extensions.md) |
| `#diff` or `#log` is missing from the list | The directory is not inside a git work tree | They are hidden there, and a typed one fails with "not a git repository" |
| A `#word` in my sentence expanded | A visible ref has exactly that name | Rename the ref, or change the trigger |

If none of this explains it, open an issue and include the output of `/ref doctor`.
