# pi gallery listing

The pi package gallery lists packages that carry the `pi-package` keyword; each `package.json` already has it. These lines are for a listing form, a pull request to a list, or a link in a thread. Each says what the package does, with no adjectives.

## pi-switchboard

**One line:** Routes each request in pi to a model tier by complexity, with several models per tier, health tracking and an audit trail.

**Two sentences:** A classifier reads each request and routes it to a model tier, for the main session and for pi-subagents children. When a model or account hits a usage limit, the next account takes over mid-task and the navigator shows the decision.

- Install: `pi install npm:@crisboarna/pi-switchboard`
- Docs: <https://crisboarna.github.io/pi-extensions/pi-switchboard/>

## pi-account-guard

**One line:** Stops a pi session from sending a turn to a model account that does not belong to the zone of the directory it works in.

**Two sentences:** You tag accounts work or personal and places by zone. Before a turn is sent, the guard checks the pair and blocks a mismatch; the block offers to switch to an account of this zone, allow once, allow for the session, or cancel.

- Install: `pi install npm:@crisboarna/pi-account-guard`
- Docs: <https://crisboarna.github.io/pi-extensions/pi-account-guard/>

## pi-context-refs

**One line:** Save context refs and insert them from a `#` picker as compact placeholders that expand to real content when the message is sent.

**Two sentences:** A ref is a path, a file, a snippet of text, or a command or URL, saved once with a name. You type `#` and pick it; a command or URL from a project's shared library runs only after you approve its exact definition.

- Install: `pi install npm:@crisboarna/pi-context-refs`
- Docs: <https://crisboarna.github.io/pi-extensions/pi-context-refs/>

## Check before using any of these

Each sentence above restates the package README's own opening and its feature list. Reread the README before posting and change the line if the package changed. The installs work only after the release is published.
