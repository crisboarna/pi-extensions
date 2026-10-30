/** The schema a library file points to, so an editor can validate it. */
export const SCHEMA_URL = "https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-context-refs/schema/pi-context-refs.schema.json";

/** A library file on disk, with the reads and writes injected. */
export interface LibraryFile {
	path: string;
	/** The text of the file, or undefined when it does not exist. */
	read(): string | undefined;
	/** Replaces the file atomically and creates it, and its directory, when missing. */
	write(text: string): void;
}

/** What a change decides: the new list of entries for `refs`, or a reason to refuse. */
export type LibraryChange = { refs: unknown[] } | { error: string };

export type WriteResult = { ok: true } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The entries of `refs` as they are on disk right now, or why the file cannot be used. */
export function readLibraryEntries(file: LibraryFile): { ok: true; entries: unknown[] } | { ok: false; error: string } {
	const loaded = loadDocument(file);
	return loaded.ok ? { ok: true, entries: loaded.refs } : loaded;
}

/** The one way the package changes a library file: re-read, change, write atomically. Refuses, writing nothing, when the file does not parse or the change refuses. Keys it does not know, and Refs that are invalid, are kept as they are. */
export function updateLibraryFile(file: LibraryFile, change: (refs: unknown[]) => LibraryChange): WriteResult {
	const loaded = loadDocument(file);
	if (!loaded.ok) return loaded;
	const changed = change([...loaded.refs]);
	if ("error" in changed) return { ok: false, error: changed.error };
	const document = { ...loaded.document, refs: changed.refs };
	try {
		file.write(`${JSON.stringify(document, null, 2)}\n`);
	} catch (error) {
		return { ok: false, error: `${file.path} could not be written: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true };
}

type Loaded = { ok: true; document: Record<string, unknown>; refs: unknown[] } | { ok: false; error: string };

function loadDocument(file: LibraryFile): Loaded {
	let text: string | undefined;
	try {
		text = file.read();
	} catch (error) {
		return { ok: false, error: `${file.path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (text === undefined) return { ok: true, document: { version: 1, $schema: SCHEMA_URL }, refs: [] };
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `${file.path} does not parse: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isObject(data)) return { ok: false, error: `${file.path} must be a JSON object` };
	if (data.version !== 1) return { ok: false, error: `${file.path} $.version must be 1` };
	if (data.refs !== undefined && !Array.isArray(data.refs)) return { ok: false, error: `${file.path} $.refs must be a list` };
	return { ok: true, document: data, refs: data.refs ?? [] };
}
