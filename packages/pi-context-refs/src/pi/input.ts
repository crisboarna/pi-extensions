import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addBuiltins } from "../core/builtins.ts";
import type { CommandEnv } from "../core/dynamic.ts";
import { expandRefs } from "../core/expand.ts";
import { createLibraryState, type LibraryState } from "../core/library-state.ts";
import { readSettings } from "../core/ref-list.ts";
import { visibleRefs } from "../core/resolve.ts";
import { trackRun } from "./running.ts";

/** What the input handler needs from outside pi, so tests can stand in for the machine. */
export interface InputDeps extends CommandEnv {
	/** The Global library file. */
	libraryPath: string;
	home: string;
	readText: (path: string) => string | undefined;
	/** The bytes of a file; it rejects with the system's error. */
	readFile: (path: string) => Promise<Uint8Array>;
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

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return undefined;
		const { refs, notices } = current().refresh();
		showNotices(notices, ctx, deps);
		const visible = addBuiltins(visibleRefs(refs), builtinsSetting(deps));
		const run = trackRun(ctx, deps.runCommand);
		let expansion: Awaited<ReturnType<typeof expandRefs>>;
		try {
			expansion = await expandRefs(event.text, visible, { ...deps, cwd: ctx.cwd, runCommand: run.runCommand, signal: run.signal });
		} finally {
			run.finish();
		}
		if (run.signal.aborted) return cancelSend(event.text, ["cancelled"], ctx);
		const { text, failures } = expansion;
		if (failures.length > 0) {
			const reasons = failures.map((failure) => `#${failure.name}: ${failure.reason}`);
			if (ctx.mode === "tui") return cancelSend(event.text, reasons, ctx);
			showNotices(reasons, ctx, deps);
		}
		if (text === event.text) return undefined;
		return event.images ? { action: "transform", text, images: event.images } : { action: "transform", text };
	});
}

/** The `builtins` setting from the Global library file, read at every send so an edit counts at once. */
function builtinsSetting(deps: InputDeps): boolean | string[] {
	try {
		return readSettings(deps.readText(deps.libraryPath)).builtins;
	} catch {
		return true;
	}
}

/** The TUI refuses a send it cannot complete: the draft comes back, then the notice, whose repaint shows the restored draft. */
function cancelSend(draft: string, reasons: string[], ctx: ExtensionContext): { action: "handled" } {
	ctx.ui.setEditorText(draft);
	ctx.ui.notify(`pi-context-refs: ${reasons.join("\n")}`, "error");
	return { action: "handled" };
}

/** A warning goes to the notification line where there is a UI (the TUI, and the client in RPC) and to stderr where there is none. */
function showNotices(notices: string[], ctx: ExtensionContext, deps: InputDeps): void {
	for (const notice of notices) {
		if (ctx.hasUI) ctx.ui.notify(`pi-context-refs: ${notice}`, "warning");
		else deps.writeStderr(`pi-context-refs: ${notice}\n`);
	}
}
