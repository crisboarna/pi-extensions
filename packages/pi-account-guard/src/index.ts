import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { multiPassLabel } from "./core/multi-pass.ts";
import { createExitCodeKeeper } from "./pi/exit-code.ts";
import { readTextIfPresent, realpathIfPresent, writeTextAtomically } from "./pi/fs.ts";
import { readGitRemoteUrls } from "./pi/git.ts";
import { registerGuard } from "./pi/hooks.ts";
import { pooledProviders } from "./pi/pooled.ts";

export default function accountGuard(pi: ExtensionAPI): void {
	// Stored next to the config, so the notice shows once per agent folder.
	const firstRunMarker = join(getAgentDir(), "account-guard.first-run");
	registerGuard(pi, {
		home: homedir(),
		configPath: join(getAgentDir(), "account-guard.json"),
		env: process.env,
		readConfigText: readTextIfPresent,
		writeConfigText: writeTextAtomically,
		multiPassLabel: (provider) => {
			try {
				return multiPassLabel(readTextIfPresent(join(getAgentDir(), "multi-pass.json")), provider);
			} catch {
				return undefined;
			}
		},
		realpath: realpathIfPresent,
		readRemoteUrls: (cwd) => readGitRemoteUrls(cwd),
		pooledProviders,
		firstRun: {
			seen: () => readTextIfPresent(firstRunMarker) !== undefined,
			remember: () => writeTextAtomically(firstRunMarker, `${new Date().toISOString()} the first-run notice was shown\n`),
		},
		writeStderr: (text) => void process.stderr.write(text),
		setExitCode: createExitCodeKeeper(),
	});
}
