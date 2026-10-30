import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerRefCommand } from "./pi/commands.ts";
import { readFileBytes, readTextIfPresent, writeTextAtomically } from "./pi/fs.ts";
import { registerInput } from "./pi/input.ts";

/** Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. */
export default function extension(pi: ExtensionAPI): void {
	registerInput(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		home: homedir(),
		readText: readTextIfPresent,
		readFile: readFileBytes,
		writeStderr: (text) => void process.stderr.write(text),
	});
	registerRefCommand(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		readText: readTextIfPresent,
		writeText: writeTextAtomically,
		writeStderr: (text) => void process.stderr.write(text),
	});
}
