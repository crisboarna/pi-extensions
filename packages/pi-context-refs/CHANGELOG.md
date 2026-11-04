# @crisboarna/pi-context-refs

## 0.1.0

### Minor Changes

- [#218](https://github.com/crisboarna/pi-extensions/pull/218) [`cc9db0c`](https://github.com/crisboarna/pi-extensions/commit/cc9db0c75524d31bc98bf0a0c38459e7e42b1864) Thanks [@crisboarna](https://github.com/crisboarna)! - First release: save the context you keep giving the model as named refs, and send one by typing `#name` or picking it from a list. The editor shows a short placeholder, and the model gets the full content when you send. Requires Node 22.19 or later; checked with pi 1.4.
  
  - **Context without retyping.** A ref is a Path, a File, a Snippet or a Dynamic ref (a command or a URL), saved once with `/ref add`. `/ref list`, `edit`, `remove` and `sent` manage them.
  - **A picker and a draft you can read.** Typing `#` opens a list of your refs, and a pick inserts `[ref:name]`. The editor treats the placeholder as one unit, so one Backspace deletes all of it, and the cursor skips over it. `alt+r` opens an overlay with a filter and a preview of what the model will get, and it saves files this session used as refs.
  - **Fresh content.** Every ref is read when you send, never when you pick, so the model never gets a stale copy. File refs are cut at pi's read-tool limits, and binary files are refused.
  - **Safe commands.** A command is an argv array run with no shell. A command or URL in a project's shared library runs only after you approve its exact definition; `/ref approvals`, `approve` and `revoke` show and manage those approvals, which are stored outside the project.
  - **Shared with a team, private for you.** `.pi/pi-context-refs.json` in a trusted project holds refs for everyone, confined to the project. Your own refs live in your agent directory and can be scoped to one repository.
  - **Four refs with no setup.** `#diff`, `#staged`, `#status` and `#log` send git output inside a git work tree.
  - **Works without the picker.** `Review #diff` and `Review [ref:diff]` mean the same and work in print, JSON and RPC mode as well. A failed ref puts your draft back with the reason.
  - **A short transcript.** Each block collapses to one line, and `/ref sent` shows the full text of the last message.
  - **Beside other extensions.** The package wraps whichever editor was installed last, so the placeholder stays one unit beside extensions that replace the editor.
  - **Tested against a stated range of pi.** It declares pi `>=1.4.0 <2`, the range CI runs the suites against, instead of promising every version.
  - **A `pi-context-refs` skill.** Ask the agent why a `#name` did not expand, what a ref sends, or how to add or share a ref; it reads your libraries and proposes `/ref` commands for you to run, and never approves a command for you.
  - **`/ref doctor` says what is wrong.** It checks both libraries, the approvals file, git, the editor and the trigger, and says what to do about each: a project that pi does not trust, a project command that waits for approval, a placeholder that is plain text and why. It only reads.
