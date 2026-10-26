---
name: verify-extension
description: Verify a package from this monorepo in a real pi session, isolated from the user's own pi setup. Use after changing runtime behaviour, before claiming a change works, or when a README limitation says something is unverified.
---

# Verify an extension in a real pi session

Unit and integration tests run against a fake host. This checks the real one without touching `~/.pi`.

1. Make an isolated agent directory: `export PI_CODING_AGENT_DIR="$(mktemp -d)"`. Copy in only the settings or config the check needs; never copy `auth.json` without asking the user.
2. Load only the package under test: `pi -ne -e ./packages/<name>/src/index.ts`. Add `-p "<prompt>"` for a non-interactive run; note that print mode hides notifications.
3. For the installed shape, also run `npm run smoke:pack -- @crisboarna/<name>`.
4. Exercise each changed command, tool or event path. Use local or free models where the package allows it, and ask before spending the user's paid quota.
5. Record what you ran, what you saw, and what you could not check. Update the package README's Limitations when a listed gap is now verified, or when you found a new one.
6. Remove the temporary agent directory.
