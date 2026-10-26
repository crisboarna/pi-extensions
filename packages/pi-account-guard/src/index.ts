import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGitRemoteUrls } from "./pi/git.ts";
import { keepExitCode } from "./pi/exit-code.ts";
import { multiPassLabel } from "./core/multi-pass.ts";
import { readTextIfPresent, realpathIfPresent, writeTextAtomically } from "./pi/fs.ts";
import { registerGuard } from "./pi/hooks.ts";
import { pooledProviders } from "./pi/pooled.ts";

export default function accountGuard(pi: ExtensionAPI): void {
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
		writeStderr: (text) => void process.stderr.write(text),
		setExitCode: keepExitCode,
	});
}
