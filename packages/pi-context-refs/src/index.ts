import { homedir } from "node:os";
import { join } from "node:path";
import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { registerRefCommand } from "./pi/commands.ts";
import { registerEditor } from "./pi/editor.ts";
import { commandEnv } from "./pi/exec.ts";
import { urlEnv } from "./pi/fetch.ts";
import { readFileBytes, readTextIfPresent, realpathIfPresent, writeTextAtomically } from "./pi/fs.ts";
import { readRemoteUrls } from "./pi/git-remotes.ts";
import { registerInput } from "./pi/input.ts";
import { registerTranscript } from "./pi/transcript.ts";

/** Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. */
export default function extension(pi: ExtensionAPI): void {
	registerInput(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		home: homedir(),
		readText: readTextIfPresent,
		readFile: readFileBytes,
		truncateHead,
		imageType: detectSupportedImageMimeTypeFromFile,
		realpath: realpathIfPresent,
		readRemotes: readRemoteUrls,
		approvalsPath: join(getAgentDir(), "pi-context-refs-approvals.json"),
		writeText: writeTextAtomically,
		now: () => new Date(),
		...commandEnv((command, args, options) => pi.exec(command, args, options)),
		...urlEnv(),
		writeStderr: (text) => void process.stderr.write(text),
	});
	registerRefCommand(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		readText: readTextIfPresent,
		writeText: writeTextAtomically,
		approvalsPath: join(getAgentDir(), "pi-context-refs-approvals.json"),
		now: () => new Date(),
		writeStderr: (text) => void process.stderr.write(text),
		home: homedir(),
		realpath: realpathIfPresent,
		readRemotes: readRemoteUrls,
	});
	registerEditor(pi);
	registerTranscript(pi);
}
