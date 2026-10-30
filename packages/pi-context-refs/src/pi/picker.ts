import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { applyPick, type PickerRow, pickerRows } from "../core/picker.ts";
import { readSettings, settingsProblems } from "../core/ref-list.ts";
import { triggerQuery } from "../core/trigger.ts";
import { createLibraries, type Libraries, type LibraryDeps } from "./libraries.ts";

/** What the picker needs from outside pi, so tests can stand in for the machine. */
export interface PickerDeps extends LibraryDeps {
	/** Whether a directory is inside a git work tree. */
	isGitWorkTree: (cwd: string) => Promise<boolean>;
}

/** One session's picker: the Trigger it started with and what it has learned about the directory. */
interface PickerSession {
	ctx: ExtensionContext;
	trigger: string;
	libraries: Libraries;
	deps: PickerDeps;
	/** False once the session has shut down. */
	active: boolean;
	/** Asking git costs a process, so a bare Trigger asks and the keys after it reuse the answer. */
	workTree?: { cwd: string; answer: boolean };
}

const isNumber = (query: string): boolean => /^\d+$/.test(query);

function toItem(row: PickerRow): AutocompleteItem {
	return { value: row.value, label: `${row.mark} ${row.name}`, description: `${row.kind} · ${row.description}` };
}

/** The rows for a typed query, or none when the session is over, the libraries or git cannot be read, or nothing matches. */
async function rowsFor(session: PickerSession, query: string, signal: AbortSignal): Promise<PickerRow[]> {
	const { ctx, deps } = session;
	try {
		const { visible, layers } = session.libraries.refresh(ctx);
		if (session.workTree?.cwd !== ctx.cwd || query === "") session.workTree = { cwd: ctx.cwd, answer: await deps.isGitWorkTree(ctx.cwd) };
		if (signal.aborted || !session.active) return [];
		return pickerRows({ visible, layers, inWorkTree: session.workTree.answer }, query);
	} catch {
		return [];
	}
}

/** The Global library file's text, or undefined when it is missing or cannot be read; the session then starts with the default settings. */
function readQuietly(deps: PickerDeps): string | undefined {
	try {
		return deps.readText(deps.libraryPath);
	} catch {
		return undefined;
	}
}

/** The autocomplete provider for the Trigger, stacked on `current`: what it does not claim goes to `current`. */
function pickerProvider(current: AutocompleteProvider, session: PickerSession): AutocompleteProvider {
	const { trigger } = session;
	return {
		triggerCharacters: [trigger],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const query = triggerQuery((lines[cursorLine] ?? "").slice(0, cursorCol), trigger);
			if (session.active && query !== undefined && !isNumber(query)) {
				const rows = await rowsFor(session, query, options.signal);
				if (rows.length > 0) return { items: rows.map(toItem), prefix: `${trigger}${query}` };
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, typed) =>
			applyPick(lines, cursorLine, cursorCol, item.value, typed) ?? current.applyCompletion(lines, cursorLine, cursorCol, item, typed),
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
	};
}

/**
 * Adds the Trigger's picker to pi's autocomplete chain at each `session_start` in the TUI. The Trigger is read then, so a change in the
 * Global library file counts after `/reload`. A bare Trigger opens every row; `#text` is claimed only when a row matches, and a numeric
 * or unmatched token goes to the next autocomplete provider in the chain.
 */
export function registerPicker(pi: ExtensionAPI, deps: PickerDeps): void {
	let session: PickerSession | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const text = readQuietly(deps);
		for (const problem of settingsProblems(text)) ctx.ui.notify(`pi-context-refs: ${problem}`, "warning");
		const started: PickerSession = { ctx, trigger: readSettings(text).trigger, libraries: createLibraries(deps), deps, active: true };
		session = started;
		ctx.ui.addAutocompleteProvider((current) => pickerProvider(current, started));
	});

	pi.on("session_shutdown", () => {
		if (session) session.active = false;
	});
}
