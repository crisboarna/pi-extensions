import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandEnv } from "../core/dynamic.ts";
import { expandRefs } from "../core/expand.ts";
import type { TruncateHead } from "../core/file-content.ts";
import { isUsedProjectFile, type UsedFiles } from "../core/recent.ts";
import { printable } from "../core/text.ts";
import type { UrlEnv } from "../core/url.ts";
import { type ApprovalDeps, createApprover } from "./approvals.ts";
import { createLibraries, type LibraryDeps } from "./libraries.ts";
import { type CommandRun, createSendSet, type SendSet, trackRun } from "./running.ts";

/** What the input handler needs from outside pi, so tests can stand in for the machine. */
export interface InputDeps extends LibraryDeps, ApprovalDeps, CommandEnv {
	/** The bytes of a file; it rejects with the system's error. */
	readFile: (path: string, limit: number) => Promise<Uint8Array>;
	/** Pi's `truncateHead`: cuts a File at the caps of pi's read tool. */
	truncateHead: TruncateHead;
	/** The image type pi supports for the file at this path, or null. */
	imageType: (path: string) => Promise<string | null>;
	/** Fetches a URL with a plain GET. */
	fetchUrl: UrlEnv["fetchUrl"];
	/** The files this session used; a `[ref:file:<path>]` Placeholder reads only one of them. */
	recent: UsedFiles;
	writeStderr: (text: string) => void;
	/** True while another component, an autocomplete list or the overlay, wants Esc; a send then does not take it. */
	escapeTaken?: () => boolean;
}

/**
 * True in the process that runs a pi-subagents background child (it sets this variable, and pi-subagents
 * documents it as the child marker). The task text there was written by the parent model, and no Ref may
 * be triggered by the model (DESIGN.md, threat model).
 */
function isSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

type Expansion = Awaited<ReturnType<typeof expandRefs>>;

/** Expands typed refs and Placeholders in each message that is sent, in every mode. */
export function registerInput(pi: ExtensionAPI, deps: InputDeps): void {
	const libraries = createLibraries(deps);

	pi.on("session_start", (_event, ctx) => {
		// A new session starts with a fresh set of warnings, so each one shows once per session.
		libraries.start();
		ended = false;
		showNotices(libraries.refresh(ctx).notices, ctx, deps);
	});

	// The sends in progress, so shutting the session down can cancel them all; `ended` tells a send that its session is gone.
	const sends: SendSet = createSendSet(deps.escapeTaken);
	const current = new Set<CommandRun>();
	let ended = false;
	pi.on("session_shutdown", () => {
		ended = true;
		for (const run of current) run.abort();
	});

	/** Expands `text` with the commands and fetches of this send tracked, or gives the reason expanding threw. */
	const expandMessage = async (text: string, ctx: ExtensionContext): Promise<{ expansion: Expansion; cancelled: boolean } | { error: string }> => {
		const { visible, layers, notices } = libraries.refresh(ctx);
		showNotices(notices, ctx, deps);
		const run = trackRun(ctx, deps.runCommand, deps.fetchUrl, sends);
		current.add(run);
		try {
			const expansion = await expandRefs(text, visible, {
				...deps,
				cwd: ctx.cwd,
				usedFile: (path) => isUsedProjectFile(path, ctx.cwd, deps.recent, deps.realpath),
				layers,
				approve: createApprover(ctx, deps),
				runCommand: run.runCommand,
				fetchUrl: run.fetchUrl,
				signal: run.signal,
			});
			return { expansion, cancelled: run.signal.aborted };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		} finally {
			run.finish();
			current.delete(run);
		}
	};

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || isSubagentChild()) return undefined;
		const outcome = await expandMessage(event.text, ctx);
		if (ended) return { action: "handled" };
		if ("error" in outcome) {
			// pi sends the text as typed when a handler throws; a Ref left unexpanded must not go out as if it were meant.
			const reasons = [`could not expand the message: ${outcome.error}`];
			if (ctx.mode === "tui") return cancelSend(event.text, reasons, ctx);
			showNotices(reasons, ctx, deps);
			return { action: "handled" };
		}
		if (outcome.cancelled) return cancelSend(event.text, ["cancelled"], ctx);
		const { text, images, failures } = outcome.expansion;
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

/** The TUI refuses a send it cannot complete: the draft comes back, then the notice, whose repaint shows the restored draft. Text typed while the send ran stays, below the draft. */
function cancelSend(draft: string, reasons: string[], ctx: ExtensionContext): { action: "handled" } {
	const typed = ctx.ui.getEditorText();
	ctx.ui.setEditorText(typed === "" ? draft : `${draft}\n${typed}`);
	ctx.ui.notify(printable(`pi-context-refs: ${reasons.join("\n")}`), "error");
	return { action: "handled" };
}

/** A warning goes to the notification line where there is a UI (the TUI, and the client in RPC) and to stderr where there is none. */
function showNotices(notices: string[], ctx: ExtensionContext, deps: InputDeps): void {
	for (const notice of notices) {
		const line = printable(`pi-context-refs: ${notice}`);
		if (ctx.hasUI) ctx.ui.notify(line, "warning");
		else deps.writeStderr(`${line}\n`);
	}
}
