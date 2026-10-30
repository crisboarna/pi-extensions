import { parseLibrary, type Ref } from "./library.ts";

/** The library as the session sees it after one look at the file. */
export interface LibraryRefresh {
	refs: readonly Ref[];
	/** Warnings not shown before in this session. */
	notices: string[];
}

export interface LibraryState {
	/** Reads the file again and returns the Refs to use. Call it before a send. */
	refresh(): LibraryRefresh;
}

/** A library file as the session sees it: re-read on every refresh, the last good copy kept while the file does not load, each warning reported once. */
export function createLibraryState(file: string, read: () => string | undefined): LibraryState {
	let refs: readonly Ref[] = [];
	let hasGoodCopy = false;
	const reported = new Set<string>();

	const unreported = (warnings: string[]): string[] => {
		const fresh = warnings.filter((warning) => !reported.has(warning));
		for (const warning of fresh) reported.add(warning);
		return fresh;
	};

	return {
		refresh() {
			const fileRead = readFile(file, read);
			if (fileRead.missing) {
				refs = [];
				hasGoodCopy = false;
				return { refs, notices: [] };
			}
			const loaded = fileRead.text === undefined ? { ok: false as const, error: fileRead.error } : parseLibrary(fileRead.text, file);
			if (loaded.ok) {
				refs = loaded.refs;
				hasGoodCopy = true;
				return { refs, notices: unreported(loaded.warnings) };
			}
			const outcome = hasGoodCopy ? "keeping the last good copy" : "no Refs are loaded";
			return { refs, notices: unreported([`${loaded.error}; ${outcome}`]) };
		},
	};
}

type FileRead = { missing: true } | { missing: false; text: string; error?: never } | { missing: false; text?: never; error: string };

function readFile(file: string, read: () => string | undefined): FileRead {
	try {
		const text = read();
		return text === undefined ? { missing: true } : { missing: false, text };
	} catch (error) {
		return { missing: false, error: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
}
