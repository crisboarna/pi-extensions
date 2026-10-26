# pi extensions by @crisboarna

Extensions for the [pi](https://pi.dev) coding agent. Each package installs on its own from npm.

| Package | What it does | Install |
|---|---|---|
| [`@crisboarna/pi-switchboard`](packages/pi-switchboard) | Picks a model for every piece of work, including pi-subagents children: a local classifier sets the tier, a strategy picks a model, failover keeps work going when a subscription runs dry, and every decision is recorded. | `pi install npm:@crisboarna/pi-switchboard` |

Restart pi after installing.

## Quality

Every package passes the same gates before it is published: strict TypeScript, lint and format, dead-code analysis, coverage thresholds, integration tests through pi's loader, an install-from-tarball smoke test, and a reviewed list of published files. Releases are published from CI with npm provenance, so each version traces back to the commit and workflow that built it. The full list is in [docs/guardrails.md](docs/guardrails.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents working in this repository start from [AGENTS.md](AGENTS.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
