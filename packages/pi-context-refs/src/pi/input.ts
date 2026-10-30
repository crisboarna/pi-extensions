import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandRefs } from "../core/expand.ts";
import { createLibraryState, type LibraryState } from "../core/library-state.ts";
import { visibleRefs } from "../core/resolve.ts";

/** What the input handler needs from outside pi, so tests can stand in for the machine. */
export interface InputDeps {
	/** The Global library file. */
	libraryPath: string;
	home: string;
	readText: (path: string) => string | undefined;
	writeStderr: (text: string) => void;
}

/** Expands typed refs and Placeholders in each message that is sent, in every mode. */
export function registerInput(pi: ExtensionAPI, deps: InputDeps): void {
	let library: LibraryState | undefined;
	const current = (): LibraryState => {
		library ??= createLibraryState(deps.libraryPath, () => deps.readText(deps.libraryPath));
		return library;
	};

	pi.on("session_start", (_event, ctx) => {
		// A new session starts with a fresh set of warnings, so each one shows once per session.
		library = undefined;
		showNotices(current().refresh().notices, ctx, deps);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return undefined;
		const { refs, notices } = current().refresh();
		showNotices(notices, ctx, deps);
		const text = expandRefs(event.text, visibleRefs(refs), { cwd: ctx.cwd, home: deps.home });
		if (text === event.text) return undefined;
		return event.images ? { action: "transform", text, images: event.images } : { action: "transform", text };
	});
}

/** A warning goes to the notification line where there is a UI (the TUI, and the client in RPC) and to stderr where there is none. */
function showNotices(notices: string[], ctx: ExtensionContext, deps: InputDeps): void {
	for (const notice of notices) {
		if (ctx.hasUI) ctx.ui.notify(`pi-context-refs: ${notice}`, "warning");
		else deps.writeStderr(`pi-context-refs: ${notice}\n`);
	}
}
