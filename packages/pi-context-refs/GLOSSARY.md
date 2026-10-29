# pi-context-refs

Saves named references to context (a path, a file, a snippet of text, a command's output or a URL's text), lets you pick them from the editor, and turns each one into real content when the message is sent.

## Language

### Refs

**Ref**:
A saved entry with a name, a kind and one target, and optionally a description and tags. Names use letters, digits, `.`, `-` and `_`, are case-insensitive, and cannot end in `.`.
_Avoid_: Snippet (that is one kind), shortcut, bookmark, macro

**Ref kind**:
What a Ref stands for, fixed when it is saved: **Path** (inserts path text), **File** (the file's contents, inlined on send), **Snippet** (saved text, inlined on send) or **Dynamic** (the output of a command or a URL, produced on send).
_Avoid_: Type, mode

**Source**:
What a Dynamic Ref runs: a command (an argument vector, never a shell string) or a URL (a plain GET).
_Avoid_: Provider, script

**Built-in Ref**:
A Dynamic Ref the package ships (`#diff`, `#staged`, `#status`, `#log`). It sits below every saved Ref, so a saved Ref with the same name shadows it.
_Avoid_: Default ref, preset

**Tag**:
A label on a Ref that groups it and narrows the picker.
_Avoid_: Category, folder, label

**Bundle**:
All the Visible Refs that carry one Tag, written `#tag:<tag>`. It is shorthand for each member, never a thing of its own: picking it inserts one Placeholder per member.
_Avoid_: Group, collection, set

### Libraries and visibility

**Ref library**:
All the Refs you can pick from: the Global library and, in a trusted project, the Project library.
_Avoid_: Registry, store

**Global library**:
Your own Refs, in your agent directory. They appear everywhere unless a Ref is scoped.
_Avoid_: User library, personal library

**Project library**:
Refs that belong to one repository and live in it, meant to be shared with its team. It loads only when pi trusts the project.
_Avoid_: Local library, repo library

**Scoped Ref**:
A Ref in the Global library that appears only where its scope matches: a path, a git remote, or both.
_Avoid_: Conditional ref

**Visible Ref**:
A Ref that applies where you are, after precedence.
_Avoid_: Active ref

**Shadowed Ref**:
A Ref hidden by a Visible Ref with the same name.
_Avoid_: Overridden ref, duplicate

**Approval**:
Your consent to run one exact Project library Dynamic Ref definition. A changed definition needs a new Approval.
_Avoid_: Trust (pi's project trust is a different thing), permission

### Picking and sending

**Trigger**:
The single character, `#` by default, that opens the picker in the editor and starts a typed ref token.
_Avoid_: Prefix, hotkey (the `alt+r` shortcut is the picker overlay key)

**Recent ref**:
A pick source that is not curated: a file the current session used. It has no name and no entry in a library.
_Avoid_: History, recent file

**Placeholder**:
The `[ref:<name>]` marker that stands for one Ref in a draft or a sent message. It names its Ref, so it means the same thing wherever the text goes. A Recent ref's Placeholder carries its path instead of a name.
_Avoid_: Chip, token (a typed `#name` is a ref token), marker

**Expansion**:
What the model receives for a Placeholder: inline text for Path and Snippet, or a Context block for File and Dynamic.
_Avoid_: Resolution, substitution

**Context block**:
The `<context-ref>` element that carries one File or Dynamic Expansion (or a failure note) after the message text.
_Avoid_: Frame (the frame is its format), attachment

**Failure note**:
A Context block with an empty body and an `error` attribute, sent in place of an Expansion that could not be produced when there is no UI to refuse the send.
_Avoid_: Error message
