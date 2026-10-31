import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { type CommandDeps, registerRefCommand } from "./pi/commands.ts";
import { registerEditor } from "./pi/editor.ts";
import { createEscapeGuard } from "./pi/escape-guard.ts";
import { commandEnv } from "./pi/exec.ts";
import { urlEnv } from "./pi/fetch.ts";
import { isFilePresent, linkTargetIfSymlink, readFileBytes, readTextIfPresent, realpathIfPresent, writeTextAtomically } from "./pi/fs.ts";
import { cachedRemoteReader, readRemoteUrls } from "./pi/git-remotes.ts";
import { type InputDeps, registerInput } from "./pi/input.ts";
import { registerOverlay } from "./pi/overlay.ts";
import { registerPicker } from "./pi/picker.ts";
import { registerRecentSource } from "./pi/recent-source.ts";
import { registerTranscript } from "./pi/transcript.ts";

/** Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. */
export default function extension(pi: ExtensionAPI): void {
	// First, so the input handler below finds the files a message points at already noted.
	const recent = registerRecentSource(pi, { home: homedir(), tmpdir: tmpdir(), now: Date.now });
	// One reader for the input handler, the commands and the picker, so the picker's per-keystroke refresh does not run git each time.
	const readRemotes = cachedRemoteReader(readRemoteUrls);
	// Esc cancels a running send unless an autocomplete list or the overlay is open and needs it.
	const escapeGuard = createEscapeGuard();
	const inputDeps: InputDeps = {
		escapeTaken: escapeGuard.taken,
		recent,
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		home: homedir(),
		readText: readTextIfPresent,
		readFile: readFileBytes,
		truncateHead,
		imageType: detectSupportedImageMimeTypeFromFile,
		realpath: realpathIfPresent,
		linkTarget: linkTargetIfSymlink,
		readRemotes,
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
		linkTarget: linkTargetIfSymlink,
		readRemotes,
	};
	registerRefCommand(pi, commandDeps);
	registerPicker(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		home: homedir(),
		readText: readTextIfPresent,
		realpath: realpathIfPresent,
		linkTarget: linkTargetIfSymlink,
		readRemotes,
		isGitWorkTree: commandEnv((command, args, options) => pi.exec(command, args, options)).isGitWorkTree,
		recent,
		now: Date.now,
		isFile: isFilePresent,
	});
	const editors = registerEditor(pi);
	escapeGuard.watch(editors.autocompleteOpen);
	registerOverlay(pi, { ...inputDeps, ...commandDeps, isFile: isFilePresent, escape: escapeGuard }, editors);
	registerTranscript(pi);
}
