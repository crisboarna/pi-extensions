import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandEnv } from "../core/dynamic.ts";
import { expandRefs } from "../core/expand.ts";
import type { TruncateHead } from "../core/file-content.ts";
import { isUsedProjectFile, type UsedFiles } from "../core/recent.ts";
import type { UrlEnv } from "../core/url.ts";
import { type ApprovalDeps, createApprover } from "./approvals.ts";
import { createLibraries, type LibraryDeps } from "./libraries.ts";
import { trackRun } from "./running.ts";

/** What the input handler needs from outside pi, so tests can stand in for the machine. */
export interface InputDeps extends LibraryDeps, ApprovalDeps, CommandEnv {
	/** The bytes of a file; it rejects with the system's error. */
	readFile: (path: string) => Promise<Uint8Array>;
	/** Pi's `truncateHead`: cuts a File at the caps of pi's read tool. */
	truncateHead: TruncateHead;
	/** The image type pi supports for the file at this path, or null. */
	imageType: (path: string) => Promise<string | null>;
	/** Fetches a URL with a plain GET. */
	fetchUrl: UrlEnv["fetchUrl"];
	/** The files this session used; a `[ref:file:<path>]` Placeholder reads only one of them. */
	recent: UsedFiles;
	writeStderr: (text: string) => void;
}

/** Expands typed refs and Placeholders in each message that is sent, in every mode. */
export function registerInput(pi: ExtensionAPI, deps: InputDeps): void {
	const libraries = createLibraries(deps);

	pi.on("session_start", (_event, ctx) => {
		// A new session starts with a fresh set of warnings, so each one shows once per session.
		libraries.start();
		showNotices(libraries.refresh(ctx).notices, ctx, deps);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return undefined;
		const { visible, layers, notices } = libraries.refresh(ctx);
		showNotices(notices, ctx, deps);
		const run = trackRun(ctx, deps.runCommand, deps.fetchUrl);
		let expansion: Awaited<ReturnType<typeof expandRefs>>;
		try {
			expansion = await expandRefs(event.text, visible, {
				...deps,
				cwd: ctx.cwd,
				usedFile: (path) => isUsedProjectFile(path, ctx.cwd, deps.recent, deps.realpath),
				layers,
				approve: createApprover(ctx, deps),
				runCommand: run.runCommand,
				fetchUrl: run.fetchUrl,
				signal: run.signal,
			});
		} finally {
			run.finish();
		}
		if (run.signal.aborted) return cancelSend(event.text, ["cancelled"], ctx);
		const { text, images, failures } = expansion;
		if (failures.length > 0) {
			const reasons = failures.map((failure) => `#${failure.name}: ${failure.reason}`);
			if (ctx.mode === "tui") return cancelSend(event.text, reasons, ctx);
			showNotices(reasons, ctx, deps);
		}
		if (text === event.text) return undefined;
		const attached = [...(event.images ?? []), ...images];
		return attached.length > 0 ? { action: "transform", text, images: attached } : { action: "transform", text };
	});
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
