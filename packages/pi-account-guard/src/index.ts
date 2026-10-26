import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGitRemoteUrls } from "./pi/git.ts";
import { readTextIfPresent, realpathIfPresent } from "./pi/fs.ts";
import { registerGuard } from "./pi/hooks.ts";

export default function accountGuard(pi: ExtensionAPI): void {
	registerGuard(pi, {
		home: homedir(),
		configPath: join(getAgentDir(), "account-guard.json"),
		readConfigText: readTextIfPresent,
		realpath: realpathIfPresent,
		readRemoteUrls: (cwd) => readGitRemoteUrls(cwd),
		writeStderr: (text) => void process.stderr.write(text),
		setExitCode: (code) => void (process.exitCode = code),
	});
}
