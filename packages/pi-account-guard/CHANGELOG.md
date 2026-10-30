# @crisboarna/pi-account-guard

## 0.1.0

### Minor Changes

- [`2b92422`](https://github.com/crisboarna/pi-extensions/commit/2b92422c977c2e5ee00fcf1139ccddebb31f1db0) Thanks [@crisboarna](https://github.com/crisboarna)! - `/guard check <path|here> [provider [source]]` says which place rule decides a directory, its zone, and whether the current account, or the named one, would pass there: a turn would go, would be blocked and why, or the tag prompt would ask first. It writes nothing, so a rule can be tried before you rely on it.

- [`d245fd0`](https://github.com/crisboarna/pi-extensions/commit/d245fd0bb542cb4a0a6915e2622aa660b8e629cb) Thanks [@crisboarna](https://github.com/crisboarna)! - The package ships a `pi-account-guard` skill: asked why a turn was blocked or how to set up zones, the agent reads `account-guard.json` and the git remotes, explains the block and proposes `/guard` commands for you to run, and never proposes a way around a block.

- [`fe14e99`](https://github.com/crisboarna/pi-extensions/commit/fe14e99a795fab0263c38c9e5e5179d6dcd63b2e) Thanks [@crisboarna](https://github.com/crisboarna)! - `/guard tour` walks through what the guard checks in four steps, with samples that go through the guard's own checks; it writes nothing. A first-run notice, shown once in the TUI before any config file exists, says that accounts start untagged, that the first turn asks for their zones, and where to look.

- [`a71f061`](https://github.com/crisboarna/pi-extensions/commit/a71f0611161b345dc5b27e3e9dd6750c0e14b046) Thanks [@crisboarna](https://github.com/crisboarna)! - First release from the pi-extensions monorepo: the account guard that blocks a turn when the model account does not belong to the zone of the session's directory, with the interactive Block, the tag prompt, `/guard` commands and the footer.

### Patch Changes

- [`e8bff75`](https://github.com/crisboarna/pi-extensions/commit/e8bff75e890dc362aa7958c6b782cb004d79fa62) Thanks [@crisboarna](https://github.com/crisboarna)! - The package gets a mark, light and dark banners and a cover image, shown in pi's package gallery through `pi.image`, and the keywords `work`, `personal`, `subscription` and `accounts`.

- [`dc3c7b4`](https://github.com/crisboarna/pi-extensions/commit/dc3c7b4dbab9132173c80d0bb23749921a5003ec) Thanks [@crisboarna](https://github.com/crisboarna)! - A one-minute demo video, shown in pi's package gallery through `pi.video` and at the top of the README.

- [`af19220`](https://github.com/crisboarna/pi-extensions/commit/af1922016686397b8ea9e888886aefe942f89157) Thanks [@crisboarna](https://github.com/crisboarna)! - The demo video (`pi.video`) is now two minutes long, slower, and narrated: a voice explains each step over a quiet music bed, with subtitles on the site.

- [`ec4ad2c`](https://github.com/crisboarna/pi-extensions/commit/ec4ad2cb48a6ad7c56fcdc6f7304811cfb1649b4) Thanks [@crisboarna](https://github.com/crisboarna)! - The tag prompt says "no auth source" instead of "no credentials" when pi has no auth source for an account, matching the glossary.

- [`4f763be`](https://github.com/crisboarna/pi-extensions/commit/4f763bef223219f90eb3bfa08e98fee877d89ac2) Thanks [@crisboarna](https://github.com/crisboarna)! - The README is now a front door: what the guard does, a quick start, what you get and the settings most people change. The reference moves to `docs/`: configuration, blocks, commands, footer, headless use, other extensions, troubleshooting and an FAQ.

- [#179](https://github.com/crisboarna/pi-extensions/pull/179) [`d21897b`](https://github.com/crisboarna/pi-extensions/commit/d21897ba697cd6f81cfeb9960f8380ed33c5f4d5) Thanks [@crisboarna](https://github.com/crisboarna)! - The README opens with a short looping animation that plays by itself on GitHub and npm; a click still opens the narrated two-minute video.
