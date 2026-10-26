# pi extensions by @crisboarna

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/crisboarna/pi-extensions/main/media/banner-dark.png">
  <img alt="pi-extensions: route every request, guard every account. The family mark, two cords crossing on an enamel panel, beside the marks of pi-switchboard and pi-account-guard" src="https://raw.githubusercontent.com/crisboarna/pi-extensions/main/media/banner-light.png" width="1100">
</picture>

Extensions for the [pi](https://pi.dev) coding agent: pi-switchboard routes every request to a model that fits it, and pi-account-guard keeps every turn on an account of the right zone. Each package installs on its own from npm.

**[The site](https://crisboarna.github.io/pi-extensions/)** has each package's docs, its demo video, an explainer that runs the package's own code on your config, and a live demo: real pi and the extension in a container in your browser.

| Package | What it does | Install |
|---|---|---|
| [`@crisboarna/pi-account-guard`](packages/pi-account-guard) | Stops a session from sending a turn to a model account that does not belong to the zone of the directory it works in, so a work subscription is never used in a personal repository by accident. Fails closed when it cannot decide. | `pi install npm:@crisboarna/pi-account-guard` |
| [`@crisboarna/pi-switchboard`](packages/pi-switchboard) | Picks a model for every piece of work, including pi-subagents children: a local classifier sets the tier, a strategy picks a model, failover keeps work going when a subscription runs dry, and every decision is recorded. | `pi install npm:@crisboarna/pi-switchboard` |

Restart pi after installing.

## Quality

Every package passes the same gates before it is published: strict TypeScript, lint and format, dead-code analysis, coverage thresholds, integration tests through pi's loader, an install-from-tarball smoke test, and a reviewed list of published files. Releases are published from CI with npm provenance, so each version traces back to the commit and workflow that built it. The full list is in [docs/guardrails.md](docs/guardrails.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents working in this repository start from [AGENTS.md](AGENTS.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
