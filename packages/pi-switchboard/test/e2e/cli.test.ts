// End to end, no model server: the `pi-switchboard classifier` paths that
// must fail cleanly, run from the bin of a freshly packed tarball
// (`npm run test:e2e`; CI runs it too).
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { type Installed, installTarball } from "./support/install.ts";
import { type Result, run } from "./support/proc.ts";
import { isolatedEnv, type Run, startRun } from "./support/run.ts";

interface SetupSpec {
	commands: string[];
	install: string;
}

let runDir: Run;
let installed: Installed;
let setups: Record<string, SetupSpec>;
/** A folder holding only `node`, so no classifier server's command is on PATH. */
let nodeOnly: string;
let cases = 0;

before(async () => {
	runDir = startRun("cli");
	installed = await installTarball(runDir);
	const catalog = join(installed.agentDir, "npm", "node_modules", "@crisboarna", "pi-switchboard", "data", "classifier-servers.json");
	setups = (JSON.parse(readFileSync(catalog, "utf8")) as { setups: Record<string, SetupSpec> }).setups;
	nodeOnly = runDir.folder("node-only");
	symlinkSync(process.execPath, join(nodeOnly, "node"));
});

/** Runs the installed bin with a fresh agent folder; `path` replaces PATH. */
async function cli(args: string[], options: { path?: string; agentDir?: string } = {}): Promise<Result> {
	const label = `case-${++cases}`;
	const agentDir = options.agentDir ?? runDir.folder(`${label}-agent`);
	const env = isolatedEnv(installed.home, { PI_CODING_AGENT_DIR: agentDir, ...(options.path ? { PATH: options.path } : {}) });
	return run(installed.bin, args, { env, cwd: installed.home, log: join(runDir.dir, `${label}.log`) });
}

function expectExit(result: Result, code: number, pattern: RegExp): void {
	assert.equal(result.code, code, runDir.explain(`exit ${result.code}, wanted ${code}:\n${result.text}`));
	assert.match(result.text, pattern, runDir.explain("unexpected output"));
}

describe("pi-switchboard classifier from the packed tarball, with no server", () => {
	it("prints its usage", async () => {
		expectExit(await cli(["--help"]), 0, /classifier setup <server>/u);
		expectExit(await cli(["classifier"]), 0, /^pi-switchboard classifier <command>/mu);
	});

	it("refuses an unknown command with the usage", async () => {
		expectExit(await cli(["classifier", "bogus"]), 1, /^pi-switchboard classifier <command>/mu);
	});

	it("asks setup for a known server name", async () => {
		const names = Object.keys(setups).join(", ");
		for (const args of [
			["setup", "--yes"],
			["setup", "nonsense", "--yes"],
		])
			expectExit(await cli(["classifier", ...args]), 1, new RegExp(`classifier setup: name one of ${names}$`, "mu"));
	});

	it("will not run setup's commands without a terminal unless given --yes", async () => {
		expectExit(await cli(["classifier", "setup", "ollama"]), 1, /without a terminal, add --yes/u);
	});

	it("says how to install each server whose command is missing", async () => {
		for (const [name, spec] of Object.entries(setups)) {
			const [command] = spec.commands;
			const result = await cli(["classifier", "setup", name, "--yes"], { path: `${nodeOnly}:/usr/bin:/bin` });
			assert.equal(result.code, 1, runDir.explain(`setup ${name}: exit ${result.code}`));
			assert.equal(result.text.trim(), `${command} was not found. ${spec.install}`, runDir.explain(`setup ${name}`));
		}
	});

	it("refuses a config that is not valid JSON before running anything, and leaves it as it was", async () => {
		const bin = runDir.folder("placeholder-bin");
		const ran = join(runDir.dir, "placeholder-ran");
		writeFileSync(join(bin, "ollama"), `#!/bin/sh\necho "$@" >> '${ran}'\n`);
		chmodSync(join(bin, "ollama"), 0o755);
		const agentDir = runDir.folder("malformed-agent");
		const config = join(agentDir, "pi-switchboard.json");
		const broken = '{ "classifiers": [ broken\n';
		writeFileSync(config, broken);
		const result = await cli(["classifier", "setup", "ollama", "--yes"], { path: `${bin}:${nodeOnly}:/usr/bin:/bin`, agentDir });
		expectExit(result, 1, /is not valid JSON: fix it or move it aside, then run setup again\./u);
		assert.equal(readFileSync(config, "utf8"), broken);
		assert.equal(existsSync(ran), false, runDir.explain("setup ran ollama"));
	});

	it("refuses an unknown detect option", async () => {
		expectExit(await cli(["classifier", "detect", "--bogus"]), 1, /^classifier detect: unknown option --bogus$/mu);
	});

	it("says no server was found when none answers", async () => {
		const urls = ["--lmstudio", "http://127.0.0.1:1", "--ollama", "http://127.0.0.1:2", "--llamacpp", "http://127.0.0.1:3"];
		const result = await cli(["classifier", "detect", ...urls]);
		expectExit(
			result,
			1,
			/^not running: LM Studio \(http:\/\/127\.0\.0\.1:1\), Ollama \(http:\/\/127\.0\.0\.1:2\), llama\.cpp \(http:\/\/127\.0\.0\.1:3\)$/mu,
		);
		assert.match(result.text, /^No classifier server found\./mu);
	});

	it("checks eval's arguments before asking anything", async () => {
		expectExit(await cli(["classifier", "eval"]), 1, /^pi-switchboard classifier <command>/mu);
		expectExit(await cli(["classifier", "eval", "http://127.0.0.1:1/v1", "m", "--threshold", "2"]), 1, /--threshold must be a number from 0 to 1/u);
		expectExit(
			await cli(["classifier", "eval", "http://127.0.0.1:1/v1", "m", "--api-key-env", "E2E_UNSET_KEY"]),
			1,
			/^classifier eval: E2E_UNSET_KEY is not set$/mu,
		);
	});

	it("reports a classifier that does not answer once, and stops", async () => {
		const result = await cli(["classifier", "eval", "http://127.0.0.1:1/v1", "m"]);
		expectExit(result, 1, /^m did not answer: fetch failed\nThe other 23 requests were not asked\.$/mu);
		assert.equal(result.text.match(/did not answer/gu)?.length, 1, runDir.explain("the error was repeated"));
	});
});
