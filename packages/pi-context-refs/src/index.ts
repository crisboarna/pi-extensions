import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { type CommandDeps, registerRefCommand } from "./pi/commands.ts";
import { registerEditor } from "./pi/editor.ts";
import { commandEnv } from "./pi/exec.ts";
import { urlEnv } from "./pi/fetch.ts";
import { isFilePresent, readFileBytes, readTextIfPresent, realpathIfPresent, writeTextAtomically } from "./pi/fs.ts";
import { readRemoteUrls } from "./pi/git-remotes.ts";
import { type InputDeps, registerInput } from "./pi/input.ts";
import { registerOverlay } from "./pi/overlay.ts";
import { registerPicker } from "./pi/picker.ts";
import { registerRecentSource } from "./pi/recent-source.ts";
import { registerTranscript } from "./pi/transcript.ts";

/** Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. */
export default function extension(pi: ExtensionAPI): void {
	// First, so the input handler below finds the files a message points at already noted.
	const recent = registerRecentSource(pi, { home: homedir(), tmpdir: tmpdir(), now: Date.now });
	const inputDeps: InputDeps = {
		recent,
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
	};
	registerInput(pi, inputDeps);
	const commandDeps: CommandDeps = {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		readText: readTextIfPresent,
		writeText: writeTextAtomically,
		approvalsPath: join(getAgentDir(), "pi-context-refs-approvals.json"),
		now: () => new Date(),
		writeStderr: (text) => void process.stderr.write(text),
		home: homedir(),
		realpath: realpathIfPresent,
		readRemotes: readRemoteUrls,
	};
	registerRefCommand(pi, commandDeps);
	registerPicker(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		home: homedir(),
		readText: readTextIfPresent,
		realpath: realpathIfPresent,
		readRemotes: readRemoteUrls,
		isGitWorkTree: commandEnv((command, args, options) => pi.exec(command, args, options)).isGitWorkTree,
		recent,
		now: Date.now,
		isFile: isFilePresent,
	});
	const editors = registerEditor(pi);
	registerOverlay(pi, { ...inputDeps, ...commandDeps, isFile: isFilePresent }, editors);
	registerTranscript(pi);
}
