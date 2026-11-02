# Commands and keys

Every `/ref` command works with full arguments. The dialogs only fill in what is missing, and with no UI a command that lacks an argument fails with its usage. In print mode `pi -p "/ref add …"` runs the command and writes its output to stderr.

## Commands

| Command | Does |
|---|---|
| `/ref`, `/ref list [tag=<tag>] [in=<library>]` | Prints the settings (`trigger`, `builtins`), your Refs by library with their kind and description, the Refs another library hides, the built-ins, any warnings, and the Approval state of each Project command |
| `/ref add <name> <kind> <target…> [desc=<text>] [tags=a,b] [in=<library>]` | Saves a Ref. The kind is `path`, `file`, `snippet` or `dynamic`. The rest of the line is the target: a path, the snippet text, an `http` or `https` address, or the command to run |
| `/ref edit <name> [key=value…]` | With pairs, changes those fields. With none, opens the Ref as JSON in an editor and checks it when you save. Renaming is allowed unless the name is taken |
| `/ref remove <name> [in=<library>]` | Removes the Ref after a confirm that shows its kind, library and target. A built-in cannot be removed |
| `/ref approvals` | Lists this project's Approvals (the Ref, its definition, the date) and the Project commands still waiting |
| `/ref approve <name>` | Shows the exact definition and asks you to confirm. Needs a UI |
| `/ref revoke <name\|*>` | Drops one Approval, or all of them for this project. Asks nothing |
| `/ref sent` | Prints the full Expansion of the last message you sent |
| `/ref doctor` | Checks both libraries, the approvals file, git, the editor and the trigger, and says what to fix. It only reads: it writes nothing and runs no ref |

A command is written as an argv with shell-style quoting and is never run through a shell. For a pipe, write the shell out: `sh -c "git log | head"`.

## Which library

`in=` picks where a Ref is saved.

| `in=` | Saves to | Use it for |
|---|---|---|
| `global` (default) | your own library, for every project | refs that are yours |
| `here` | your own library, scoped to this repository | a ref that only makes sense in one repository |
| `project` | `.pi/pi-context-refs.json` in the project | refs the whole team shares |

The default is your own library, so nothing a teammate would receive is written by accident. A name that is taken in the target library is an error that points to `/ref edit`; the same name in another library is allowed, and the result line says what it hides or is hidden by. See [Configuration](configuration.md) for the order.

Saving a command or an address in the Project library shows its exact definition once. One confirm saves the Ref and records an Approval for exactly that definition. Any later change, yours or from a pull, asks again.

## Tags and bundles

Add `tags=a,b` to a Ref. Typing `#tag:<tag>` sends every visible Ref with that tag, and picking a bundle in the list inserts one Placeholder for each member. A bundle never skips an Approval.

## Keys

| Key | Where | Does |
|---|---|---|
| `#` | the editor | opens pi's own completion list of Refs, in sections: scoped (◆), project (■), global (●), recent (↺) and bundles (⧉). Typing narrows it by name or tag |
| Tab | the list | inserts `[ref:name]`, as for any completion in pi |
| `alt+r` | the editor | opens the overlay: a filter, the library of each Ref, and the Expansion of the selected one. It always works, even when `#` does not |
| Enter | the overlay | picks the Ref; after a typed `#` the pick replaces that `#` |
| Tab | the overlay | switches a recent file between its path form and its file form |
| Ctrl+S | the overlay | saves a recent file as a Ref |
| Ctrl+E, Ctrl+D | the overlay | edits or removes a saved Ref |
| Esc | the list, the overlay | closes it |
| Backspace | after a Placeholder | deletes the whole Placeholder |

The trigger character is a setting. See [Configuration](configuration.md).

## What gets written

The libraries and the approvals file are written the same way: the file is read again just before the write, and the write is refused, naming the file and the error, if it does not parse. The write is atomic (a temporary file, then a rename) and pretty-printed with two spaces. Your formatting is normalised on the first write, and plain JSON has no comments. Keys this version does not know are kept.
