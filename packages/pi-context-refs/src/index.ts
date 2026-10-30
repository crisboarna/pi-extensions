import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerEditor } from "./pi/editor.ts";
import { readTextIfPresent } from "./pi/fs.ts";
import { registerInput } from "./pi/input.ts";

/** Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. */
export default function extension(pi: ExtensionAPI): void {
	registerInput(pi, {
		libraryPath: join(getAgentDir(), "pi-context-refs.json"),
		home: homedir(),
		readText: readTextIfPresent,
		writeStderr: (text) => void process.stderr.write(text),
	});
	registerEditor(pi);
}
