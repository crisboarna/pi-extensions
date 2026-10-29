---
status: accepted
---

# Scoped Refs win over the Project library, which wins over unscoped Global Refs

When the same name exists in several places, the order is: Scoped Ref, then Project library, then unscoped Global Ref, then Built-in Ref. Within one file the first matching Ref wins.

This differs from pi's own rule that project settings override user settings. A Scoped Ref is the user's explicit statement about exactly this repository or path, made on their own machine, so it is more specific than a file a teammate committed. An unscoped Global Ref is the general default and gives way to a shared project definition.

## Considered options

- **Project over everything (pi's rule).** Familiar, but a user could not override a teammate's Ref for one repository without editing a committed file. Rejected.
- **Global over Project.** Rejected: a project's shared definition of `#test` would lose to a personal one everywhere, and the team could not rely on its own library.
- **Refuse clashes.** Rejected: a pull would break a user's setup the moment a teammate added a name they already use.

## Consequences

- The picker marks each row's layer, and `/ref` lists every Shadowed Ref, so a hidden Ref is always findable.
- A Project Ref saved under a Scoped Ref of the same name is not Visible; the result line of `/ref add` says so.
